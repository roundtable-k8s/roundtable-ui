package main

// Fleet pods & scaling view (#182). Each knight can run multiple replicas
// (KEDA autoscaling, roundtable-k8s/roundtable#166), so the fleet handlers
// report every pod of a knight plus its scaling bounds from
// Knight.status.scaling (roundtable-k8s/roundtable#310), with ScaledObject
// and HPA reads as fallback. Pod metrics come from metrics.k8s.io when the
// API is served; without metrics-server everything else still works.
//
// All DTOs are safe projections — no raw Kubernetes objects cross the API
// boundary (#46).

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// podMetricsGVR is the metrics.k8s.io PodMetrics endpoint (metrics-server).
var podMetricsGVR = schema.GroupVersionResource{
	Group: "metrics.k8s.io", Version: "v1beta1", Resource: "pods",
}

// scaledObjectGVR is the KEDA ScaledObject, used as the scaling fallback
// when Knight.status.scaling is absent.
var scaledObjectGVR = schema.GroupVersionResource{
	Group: "keda.sh", Version: "v1alpha1", Resource: "scaledobjects",
}

// KnightPod is a safe per-pod projection of one replica of a knight (#46).
// Usage/request/limit fields are Kubernetes quantity strings ("150m",
// "256Mi") and omitted when metrics-server doesn't report the pod or the
// container spec doesn't set them.
type KnightPod struct {
	Name string `json:"name"`
	// Node is the node the pod is scheduled on, if known yet.
	Node string `json:"node,omitempty"`
	// Phase is the pod lifecycle phase (Pending/Running/Succeeded/...).
	Phase string `json:"phase"`
	// Ready is whether the knight container reports ready.
	Ready bool `json:"ready"`
	// Restarts is the knight container's restart count.
	Restarts int32 `json:"restarts"`
	// LastTerminationReason is why the container last exited (OOMKilled...).
	LastTerminationReason string `json:"lastTerminationReason,omitempty"`
	// Age is the pod's age, rounded to seconds.
	Age string `json:"age"`
	// CreatedAt is the pod creation time, RFC 3339.
	CreatedAt string `json:"createdAt,omitempty"`
	// StartedAt is when the kubelet started the pod, RFC 3339; absent while pending.
	StartedAt string `json:"startedAt,omitempty"`
	// Image is the knight container image.
	Image string `json:"image,omitempty"`
	// Draining is true when the pod has a deletionTimestamp (rollout, #246).
	Draining bool `json:"draining"`

	// CPU and memory usage from metrics.k8s.io, summed over containers.
	CPU    string `json:"cpu,omitempty"`
	Memory string `json:"memory,omitempty"`
	// Requests and limits summed over the pod's containers.
	CPURequest    string `json:"cpuRequest,omitempty"`
	CPULimit      string `json:"cpuLimit,omitempty"`
	MemoryRequest string `json:"memoryRequest,omitempty"`
	MemoryLimit   string `json:"memoryLimit,omitempty"`
}

// KnightScaling reports a knight's replica bounds and current scaling state.
// Bounds come from Knight.status.scaling (#310); current/ready count what is
// actually running.
type KnightScaling struct {
	Autoscaled  bool  `json:"autoscaled"`
	MinReplicas int32 `json:"minReplicas"`
	MaxReplicas int32 `json:"maxReplicas"`
	// DesiredReplicas is what the autoscaler (or the Deployment spec when
	// not autoscaled) asks for; nil when unknown.
	DesiredReplicas *int32 `json:"desiredReplicas,omitempty"`
	// CurrentReplicas and ReadyReplicas count live pods (status.replicas /
	// status.readyReplicas when the operator reports them).
	CurrentReplicas int32 `json:"currentReplicas"`
	ReadyReplicas   int32 `json:"readyReplicas"`
	// LastScaleTime is when the autoscaler last changed the count.
	LastScaleTime string `json:"lastScaleTime,omitempty"`
}

// k8sRequestTimeout bounds the Kubernetes calls a request makes, so a stalled
// API server answers with an error instead of hanging (#411). A variable so
// tests can shorten it.
var k8sRequestTimeout = 10 * time.Second

// k8sCtx returns the request context with the Kubernetes call deadline.
func k8sCtx(r *http.Request) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), k8sRequestTimeout)
}

// knightPodsByName lists all knight pods in the namespace once and groups them
// by their app.kubernetes.io/instance label (the knight name). One list per
// request cycle — never per knight.
func knightPodsByName(ctx context.Context, namespace string) map[string][]*corev1.Pod {
	podsByName, _ := listFleetPods(ctx, namespace)
	return podsByName
}

// listFleetPods is knightPodsByName with the list error returned, so the
// snapshot cache can tell a failed list from an empty namespace.
func listFleetPods(ctx context.Context, namespace string) (map[string][]*corev1.Pod, error) {
	podsByName := map[string][]*corev1.Pod{}
	if k8sClient == nil {
		return podsByName, nil
	}
	pods, err := k8sClient.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/name=knight",
	})
	if err != nil {
		slog.WarnContext(ctx, "K8s pod list error", "error", err)
		return podsByName, err
	}
	for i := range pods.Items {
		pod := &pods.Items[i]
		if _, ok := pod.Labels["job-name"]; ok {
			continue // skip CronJob pods
		}
		if len(pod.Spec.Containers) == 0 {
			continue
		}
		instName := pod.Labels["app.kubernetes.io/instance"]
		if instName == "" {
			continue
		}
		podsByName[instName] = append(podsByName[instName], pod)
	}
	return podsByName, nil
}

// listPodMetrics reads metrics.k8s.io once per request cycle and returns
// summed usage per pod name. A nil map means the metrics API is not served
// (no metrics-server) — callers carry on without usage numbers.
var metricsProbe = defaultMetricsProbe

// metricsProbeTTL is how long the metrics.k8s.io discovery answer — positive
// or negative — is remembered. A variable so tests can change it.
var metricsProbeTTL = 60 * time.Second

// cacheNow is the clock of the fleet read caches; tests replace it.
var cacheNow = time.Now

var probeCache struct {
	mu     sync.Mutex
	at     time.Time
	client kubernetes.Interface
	served bool
}

// defaultMetricsProbe reports whether metrics.k8s.io/v1beta1 is served —
// i.e. whether metrics-server is installed. The answer is cached for
// metricsProbeTTL.
func defaultMetricsProbe() bool {
	c := k8sClient
	if c == nil {
		return false
	}
	probeCache.mu.Lock()
	defer probeCache.mu.Unlock()
	if probeCache.client == c && !probeCache.at.IsZero() && cacheNow().Sub(probeCache.at) < metricsProbeTTL {
		return probeCache.served
	}
	_, err := c.Discovery().ServerResourcesForGroupVersion("metrics.k8s.io/v1beta1")
	probeCache.client, probeCache.at, probeCache.served = c, cacheNow(), err == nil
	return err == nil
}

func listPodMetrics(ctx context.Context, namespace string) map[string]*KnightPod {
	usage, _ := listPodMetricsErr(ctx, namespace)
	return usage
}

// listPodMetricsErr is listPodMetrics with the list error returned. A nil map
// with a nil error means the metrics API is not served.
func listPodMetricsErr(ctx context.Context, namespace string) (map[string]*KnightPod, error) {
	if dynClient == nil || !metricsProbe() {
		return nil, nil
	}
	raw, err := dynClient.Resource(podMetricsGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		// metrics.k8s.io simply not installed is the normal small-cluster
		// case; anything else is worth a line in the log.
		slog.DebugContext(ctx, "Pod metrics unavailable (metrics-server not installed?)", "error", err)
		return nil, err
	}
	usage := map[string]*KnightPod{}
	for i := range raw.Items {
		item := &raw.Items[i]
		cpu, mem := sumContainerQuantities(item.Object, "usage")
		if cpu.IsZero() && mem.IsZero() {
			continue
		}
		usage[item.GetName()] = &KnightPod{CPU: cpu.String(), Memory: mem.String()}
	}
	return usage, nil
}

// sumContainerQuantities adds up the named field (usage, requests, limits)
// over the pod-metrics containers array.
func sumContainerQuantities(obj map[string]interface{}, field string) (resource.Quantity, resource.Quantity) {
	cpu := resource.Quantity{}
	mem := resource.Quantity{}
	for _, c := range getSlice(obj, "containers") {
		cMap, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		if q, err := resource.ParseQuantity(getStr(getNestedMap(cMap, field), "cpu")); err == nil {
			cpu.Add(q)
		}
		if q, err := resource.ParseQuantity(getStr(getNestedMap(cMap, field), "memory")); err == nil {
			mem.Add(q)
		}
	}
	return cpu, mem
}

// buildKnightPod projects one pod into the safe DTO, attaching usage from the
// metrics map when present.
func buildKnightPod(pod *corev1.Pod, usage map[string]*KnightPod) KnightPod {
	kp := KnightPod{
		Name:      pod.Name,
		Node:      pod.Spec.NodeName,
		Phase:     string(pod.Status.Phase),
		Draining:  pod.DeletionTimestamp != nil,
		Age:       time.Since(pod.CreationTimestamp.Time).Round(time.Second).String(),
		Image:     pod.Spec.Containers[0].Image,
		CreatedAt: pod.CreationTimestamp.UTC().Format(time.RFC3339),
	}
	if pod.Status.StartTime != nil {
		kp.StartedAt = pod.Status.StartTime.UTC().Format(time.RFC3339)
	}
	// Sum requests and limits over containers; the knight container is
	// containers[0] but sidecars may add more.
	cpuReq := resource.Quantity{}
	cpuLim := resource.Quantity{}
	memReq := resource.Quantity{}
	memLim := resource.Quantity{}
	for _, c := range pod.Spec.Containers {
		if q, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
			cpuReq.Add(q)
		}
		if q, ok := c.Resources.Limits[corev1.ResourceCPU]; ok {
			cpuLim.Add(q)
		}
		if q, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
			memReq.Add(q)
		}
		if q, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
			memLim.Add(q)
		}
	}
	if !cpuReq.IsZero() {
		kp.CPURequest = cpuReq.String()
	}
	if !cpuLim.IsZero() {
		kp.CPULimit = cpuLim.String()
	}
	if !memReq.IsZero() {
		kp.MemoryRequest = memReq.String()
	}
	if !memLim.IsZero() {
		kp.MemoryLimit = memLim.String()
	}

	if len(pod.Status.ContainerStatuses) > 0 {
		cs := pod.Status.ContainerStatuses[0]
		kp.Ready = cs.Ready
		kp.Restarts = cs.RestartCount
		if cs.LastTerminationState.Terminated != nil {
			kp.LastTerminationReason = cs.LastTerminationState.Terminated.Reason
		}
	}
	if u, ok := usage[pod.Name]; ok {
		kp.CPU = u.CPU
		kp.Memory = u.Memory
	}
	return kp
}

// buildKnightPods projects a knight's pods, sorted by name for stable output.
func buildKnightPods(pods []*corev1.Pod, usage map[string]*KnightPod) []KnightPod {
	out := make([]KnightPod, 0, len(pods))
	for _, p := range pods {
		out = append(out, buildKnightPod(p, usage))
	}
	// sort.Slice is overkill for handfuls of pods; insertion is fine via
	// package sort for clarity.
	sortKnightPods(out)
	return out
}

func sortKnightPods(pods []KnightPod) {
	for i := 1; i < len(pods); i++ {
		for j := i; j > 0 && pods[j].Name < pods[j-1].Name; j-- {
			pods[j], pods[j-1] = pods[j-1], pods[j]
		}
	}
}

// buildKnightScaling derives the scaling DTO from the Knight CR. Preferred
// source is status.scaling (roundtable-k8s/roundtable#310); when absent —
// an older operator or a CR that never reconciled — it falls back to the
// KEDA ScaledObject for the bounds and the HPA KEDA generates for the
// desired count. Current/ready count live pods, preferring the operator's
// status.replicas/readyReplicas when set.
func buildKnightScaling(ctx context.Context, cr *unstructured.Unstructured, pods []*corev1.Pod) *KnightScaling {
	status := getNestedMap(cr.Object, "status")
	sc := getNestedMap(status, "scaling")

	scaling := &KnightScaling{}
	if sc != nil {
		scaling.Autoscaled = getBool(sc, "autoscaled")
		scaling.MinReplicas = int32(getInt(sc, "minReplicas"))
		scaling.MaxReplicas = int32(getInt(sc, "maxReplicas"))
		// desiredReplicas can legitimately be 0 (scaled to zero), so check
		// key presence rather than getInt's zero default.
		if d, ok := sc["desiredReplicas"]; ok && d != nil {
			di := int32(getInt(sc, "desiredReplicas"))
			scaling.DesiredReplicas = &di
		}
		scaling.LastScaleTime = getStr(sc, "lastScaleTime")
	} else {
		// Fallback: read the KEDA objects, memoised per knight.
		fb := kedaFallbackFor(ctx, cr.GetNamespace(), cr.GetName())
		scaling.Autoscaled = fb.autoscaled
		scaling.MinReplicas = fb.min
		scaling.MaxReplicas = fb.max
		if fb.desired != nil {
			d := *fb.desired
			scaling.DesiredReplicas = &d
		}
	}

	// Default the bounds for a plain one-replica knight.
	if scaling.MinReplicas == 0 && !scaling.Autoscaled {
		scaling.MinReplicas = 1
		scaling.MaxReplicas = 1
	}
	if scaling.MaxReplicas < scaling.MinReplicas {
		scaling.MaxReplicas = scaling.MinReplicas
	}

	// Current/ready: prefer the operator's deployment status, count pods as
	// the fallback (the operator reports what the Deployment wants, which can
	// lag a rollout).
	current := int32(getInt(status, "replicas"))
	if current == 0 {
		current = int32(len(pods))
	}
	ready := int32(getInt(status, "readyReplicas"))
	if ready == 0 {
		for _, p := range pods {
			if podIsReady(p) {
				ready++
			}
		}
	}
	scaling.CurrentReplicas = current
	scaling.ReadyReplicas = ready
	return scaling
}

// scaledToZero reports whether an autoscaled knight is parked at zero
// replicas (roundtable-k8s/roundtable#166) — idle, not broken.
func scaledToZero(scaling *KnightScaling) bool {
	if scaling == nil || !scaling.Autoscaled {
		return false
	}
	if scaling.DesiredReplicas != nil {
		return *scaling.DesiredReplicas == 0
	}
	return scaling.CurrentReplicas == 0 && scaling.MinReplicas == 0
}

// kedaFallbackTTL is how long a knight's ScaledObject/HPA lookup (found or
// not) is remembered. A variable so tests can change it.
var kedaFallbackTTL = 30 * time.Second

type kedaFallback struct {
	at         time.Time
	dyn        dynamic.Interface
	kube       kubernetes.Interface
	autoscaled bool
	min, max   int32
	desired    *int32
}

var kedaFallbackCache = struct {
	mu sync.Mutex
	m  map[string]kedaFallback
}{m: map[string]kedaFallback{}}

// kedaFallbackFor returns the ScaledObject bounds and HPA desired count of a
// knight whose status.scaling is absent, at most one lookup per knight per
// kedaFallbackTTL, negative results included.
func kedaFallbackFor(ctx context.Context, namespace, name string) kedaFallback {
	key := namespace + "/" + name
	now := cacheNow()
	kedaFallbackCache.mu.Lock()
	e, ok := kedaFallbackCache.m[key]
	kedaFallbackCache.mu.Unlock()
	if ok && e.dyn == dynClient && e.kube == k8sClient && now.Sub(e.at) < kedaFallbackTTL {
		return e
	}
	e = kedaFallback{at: now, dyn: dynClient, kube: k8sClient}
	if so := getScaledObject(ctx, namespace, name); so != nil {
		e.autoscaled = true
		spec := getNestedMap(so.Object, "spec")
		e.min = int32(getInt(spec, "minReplicaCount"))
		e.max = int32(getInt(spec, "maxReplicaCount"))
		e.desired = getHPADesired(ctx, namespace, name)
	}
	kedaFallbackCache.mu.Lock()
	for k, v := range kedaFallbackCache.m { // drop expired entries
		if now.Sub(v.at) >= kedaFallbackTTL {
			delete(kedaFallbackCache.m, k)
		}
	}
	kedaFallbackCache.m[key] = e
	kedaFallbackCache.mu.Unlock()
	return e
}

func scaledObjectExists(ctx context.Context, namespace, name string) bool {
	return dynClient != nil && getScaledObject(ctx, namespace, name) != nil
}

func getScaledObject(ctx context.Context, namespace, name string) *unstructured.Unstructured {
	if dynClient == nil {
		return nil
	}
	so, err := dynClient.Resource(scaledObjectGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil
	}
	return so
}

// getHPADesired reads the HPA KEDA generates for a ScaledObject
// (keda-hpa-<name>) and returns its desired replica count.
func getHPADesired(ctx context.Context, namespace, name string) *int32 {
	if k8sClient == nil {
		return nil
	}
	hpa, err := k8sClient.AutoscalingV2().HorizontalPodAutoscalers(namespace).Get(
		ctx, fmt.Sprintf("keda-hpa-%s", name), metav1.GetOptions{})
	if err != nil {
		return nil
	}
	d := hpa.Status.DesiredReplicas
	return &d
}

// podSnapshotTTL is how long one read of the knight pods, pod metrics and
// RoundTable defaults is shared between /api/fleet and /api/fleet/{knight}
// requests. A variable so tests can change it.
var podSnapshotTTL = 3 * time.Second

// podSnapshot is one short-lived read of the Kubernetes objects the fleet view
// needs besides the Knight CRs. Its maps are shared between requests and must
// be treated as read-only.
type podSnapshot struct {
	pods          map[string][]*corev1.Pod
	metrics       map[string]*KnightPod
	tableDefaults map[string]map[string]interface{}
}

// podSnapshotCache collapses concurrent misses into one build and remembers
// the result for podSnapshotTTL. Errors are never cached.
type podSnapshotCache struct {
	mu        sync.Mutex
	at        time.Time
	namespace string
	dyn       dynamic.Interface
	kube      kubernetes.Interface
	snap      *podSnapshot
	group     singleflight.Group
}

var fleetPodSnapshots = &podSnapshotCache{}

func (c *podSnapshotCache) fresh(namespace string) (*podSnapshot, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.snap != nil && c.namespace == namespace && c.dyn == dynClient && c.kube == k8sClient &&
		cacheNow().Sub(c.at) < podSnapshotTTL {
		return c.snap, true
	}
	return nil, false
}

// get returns the shared snapshot. When a list fails the partial result is
// returned (callers carry on without that data, as before) but not cached.
func (c *podSnapshotCache) get(ctx context.Context, namespace string) *podSnapshot {
	if s, ok := c.fresh(namespace); ok {
		return s
	}
	ch := c.group.DoChan(namespace, func() (any, error) {
		if s, ok := c.fresh(namespace); ok {
			return s, nil
		}
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), k8sRequestTimeout)
		defer cancel()
		dyn, kube := dynClient, k8sClient
		snap := &podSnapshot{}
		var errs [3]error
		snap.pods, errs[0] = listFleetPods(bctx, namespace)
		snap.metrics, errs[1] = listPodMetricsErr(bctx, namespace)
		snap.tableDefaults, errs[2] = tableDefaultsErr(bctx, namespace)
		if errs[0] == nil && errs[1] == nil && errs[2] == nil {
			c.mu.Lock()
			c.snap, c.at, c.namespace, c.dyn, c.kube = snap, cacheNow(), namespace, dyn, kube
			c.mu.Unlock()
		}
		return snap, nil
	})
	select {
	case res := <-ch:
		return res.Val.(*podSnapshot)
	case <-ctx.Done():
		return &podSnapshot{pods: map[string][]*corev1.Pod{}}
	}
}
