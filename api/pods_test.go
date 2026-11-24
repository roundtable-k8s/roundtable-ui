package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/mux"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

// makeTestPod builds a knight pod with the given instance label, ready state
// and restart count.
func makeTestPod(name, namespace, instance string, ready bool, restarts int32, age time.Duration) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":     "knight",
				"app.kubernetes.io/instance": instance,
			},
			CreationTimestamp: metav1.Time{Time: time.Now().Add(-age)},
		},
		Spec: corev1.PodSpec{
			NodeName: "node-1",
			Containers: []corev1.Container{
				{
					Name:  "knight",
					Image: "ghcr.io/roundtable-k8s/knight:latest",
					Resources: corev1.ResourceRequirements{
						Requests: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("100m"),
							corev1.ResourceMemory: resource.MustParse("256Mi"),
						},
						Limits: corev1.ResourceList{
							corev1.ResourceCPU:    resource.MustParse("500m"),
							corev1.ResourceMemory: resource.MustParse("1Gi"),
						},
					},
				},
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{
				{
					Name:         "knight",
					Ready:        ready,
					RestartCount: restarts,
				},
			},
		},
	}
}

// makeTestKnightCRWithScaling builds a Knight CR carrying a status.scaling
// block (roundtable-k8s/roundtable#310).
func makeTestKnightCRWithScaling(name, namespace, domain string, scaling map[string]interface{}) *unstructured.Unstructured {
	cr := makeTestKnightCR(name, namespace, domain)
	status := cr.Object["status"].(map[string]interface{})
	if scaling != nil {
		status["scaling"] = scaling
	}
	return cr
}

// podMetrics builds a metrics.k8s.io PodMetrics object for one pod.
func podMetrics(podName, namespace, cpu, memory string) *unstructured.Unstructured {
	return &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "metrics.k8s.io/v1beta1",
			"kind":       "PodMetrics",
			"metadata": map[string]interface{}{
				"name":      podName,
				"namespace": namespace,
			},
			"containers": []interface{}{
				map[string]interface{}{
					"name": "knight",
					"usage": map[string]interface{}{
						"cpu":    cpu,
						"memory": memory,
					},
				},
			},
		},
	}
}

// fleetResponse decodes the /api/fleet response.
func fleetResponse(t *testing.T, router *mux.Router) []KnightStatus {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/fleet", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var knights []KnightStatus
	if err := json.Unmarshal(w.Body.Bytes(), &knights); err != nil {
		t.Fatalf("failed to parse fleet response: %v", err)
	}
	return knights
}

func knightByName(t *testing.T, knights []KnightStatus, name string) KnightStatus {
	t.Helper()
	for _, k := range knights {
		if k.Name == name {
			return k
		}
	}
	t.Fatalf("knight %q not found in fleet response", name)
	return KnightStatus{}
}

// TestFleetHandlerMultiplePods checks that a knight at 3/5 replicas reports
// every pod: name, node, ready, restarts and requests/limits, plus the
// scaling block from Knight.status.scaling.
func TestFleetHandlerMultiplePods(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	pods := []*corev1.Pod{
		makeTestPod("bedivere-aaa", namespace, "bedivere", true, 0, time.Hour),
		makeTestPod("bedivere-bbb", namespace, "bedivere", true, 2, time.Hour),
		makeTestPod("bedivere-ccc", namespace, "bedivere", false, 0, time.Minute),
	}
	for _, p := range pods {
		if _, err := fakeK8sClient.CoreV1().Pods(namespace).Create(nil, p, metav1.CreateOptions{}); err != nil {
			t.Fatalf("failed to create pod: %v", err)
		}
	}

	cr := makeTestKnightCRWithScaling("bedivere", namespace, "coding", map[string]interface{}{
		"autoscaled":      true,
		"minReplicas":     int64(0),
		"maxReplicas":     int64(5),
		"desiredReplicas": int64(3),
		"lastScaleTime":   "2026-04-01T10:00:00Z",
	})
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, cr, metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}

	knights := fleetResponse(t, router)
	k := knightByName(t, knights, "bedivere")

	if k.Status != "online" {
		t.Errorf("expected status 'online', got '%s'", k.Status)
	}
	if len(k.Pods) != 3 {
		t.Fatalf("expected 3 pods, got %d", len(k.Pods))
	}
	// Pods are sorted by name for stable output.
	if k.Pods[0].Name != "bedivere-aaa" || k.Pods[1].Name != "bedivere-bbb" || k.Pods[2].Name != "bedivere-ccc" {
		t.Errorf("pods not sorted or missing: %s, %s, %s", k.Pods[0].Name, k.Pods[1].Name, k.Pods[2].Name)
	}
	if k.Pods[0].Node != "node-1" {
		t.Errorf("expected node 'node-1', got '%s'", k.Pods[0].Node)
	}
	if !k.Pods[1].Ready || k.Pods[1].Restarts != 2 {
		t.Errorf("expected pod b ready with 2 restarts, got ready=%v restarts=%d", k.Pods[1].Ready, k.Pods[1].Restarts)
	}
	if k.Pods[2].Ready {
		t.Error("expected pod c not ready")
	}
	// Requests and limits are summed and projected as quantity strings.
	if k.Pods[0].CPURequest != "100m" || k.Pods[0].CPULimit != "500m" {
		t.Errorf("unexpected cpu request/limit: %s/%s", k.Pods[0].CPURequest, k.Pods[0].CPULimit)
	}
	if k.Pods[0].MemoryRequest != "256Mi" || k.Pods[0].MemoryLimit != "1Gi" {
		t.Errorf("unexpected memory request/limit: %s/%s", k.Pods[0].MemoryRequest, k.Pods[0].MemoryLimit)
	}
	// No metrics API: usage fields stay empty but everything else shows.
	if k.Pods[0].CPU != "" || k.Pods[0].Memory != "" {
		t.Errorf("expected no usage without metrics API, got cpu=%s memory=%s", k.Pods[0].CPU, k.Pods[0].Memory)
	}

	if k.Scaling == nil {
		t.Fatal("expected scaling block")
	}
	if !k.Scaling.Autoscaled || k.Scaling.MinReplicas != 0 || k.Scaling.MaxReplicas != 5 {
		t.Errorf("unexpected scaling bounds: %+v", k.Scaling)
	}
	if k.Scaling.DesiredReplicas == nil || *k.Scaling.DesiredReplicas != 3 {
		t.Errorf("expected desired replicas 3, got %v", k.Scaling.DesiredReplicas)
	}
	if k.Scaling.CurrentReplicas != 3 || k.Scaling.ReadyReplicas != 2 {
		t.Errorf("expected current=3 ready=2, got current=%d ready=%d", k.Scaling.CurrentReplicas, k.Scaling.ReadyReplicas)
	}
	if k.Scaling.LastScaleTime != "2026-04-01T10:00:00Z" {
		t.Errorf("expected lastScaleTime, got '%s'", k.Scaling.LastScaleTime)
	}
}

// TestFleetHandlerScaledToZero checks that a KEDA-scaled knight parked at
// zero replicas is reported as scaled-to-zero, not offline (#182, #166).
func TestFleetHandlerScaledToZero(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	cr := makeTestKnightCRWithScaling("kay", namespace, "idle", map[string]interface{}{
		"autoscaled":      true,
		"minReplicas":     int64(0),
		"maxReplicas":     int64(5),
		"desiredReplicas": int64(0),
	})
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, cr, metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}

	knights := fleetResponse(t, router)
	k := knightByName(t, knights, "kay")

	if k.Status != "scaled-to-zero" {
		t.Errorf("expected status 'scaled-to-zero', got '%s'", k.Status)
	}
	if k.Ready {
		t.Error("scaled-to-zero knight must not be ready")
	}
	if len(k.Pods) != 0 {
		t.Errorf("expected no pods, got %d", len(k.Pods))
	}
	if k.Scaling == nil || !k.Scaling.Autoscaled {
		t.Fatalf("expected autoscaled scaling block, got %+v", k.Scaling)
	}
	if k.Scaling.DesiredReplicas == nil || *k.Scaling.DesiredReplicas != 0 {
		t.Errorf("expected desired 0, got %v", k.Scaling.DesiredReplicas)
	}
}

// TestFleetHandlerDrainingPod checks that a pod with a deletionTimestamp
// (rollout drain, #246) is marked draining.
func TestFleetHandlerDrainingPod(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	now := metav1.Now()
	pod := makeTestPod("geraint-aaa", namespace, "geraint", true, 0, time.Hour)
	pod.DeletionTimestamp = &now
	pod.Status.ContainerStatuses[0].LastTerminationState = corev1.ContainerState{
		Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled"},
	}
	if _, err := fakeK8sClient.CoreV1().Pods(namespace).Create(nil, pod, metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create pod: %v", err)
	}
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil,
		makeTestKnightCR("geraint", namespace, "coding"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}

	knights := fleetResponse(t, router)
	k := knightByName(t, knights, "geraint")

	if len(k.Pods) != 1 {
		t.Fatalf("expected 1 pod, got %d", len(k.Pods))
	}
	if !k.Pods[0].Draining {
		t.Error("expected pod to be draining")
	}
	if k.Pods[0].LastTerminationReason != "OOMKilled" {
		t.Errorf("expected lastTerminationReason 'OOMKilled', got '%s'", k.Pods[0].LastTerminationReason)
	}
	// A draining pod still shows node and image.
	if k.Pods[0].Node != "node-1" || k.Pods[0].Image == "" {
		t.Errorf("expected node and image on draining pod, got %+v", k.Pods[0])
	}
}

// TestKnightHandlerPodsAndMetrics checks the /api/fleet/{knight} detail
// endpoint: pods, usage from metrics.k8s.io, and a one-replica knight whose
// scaling defaults sensibly without a ScaledObject.
func TestKnightHandlerPodsAndMetrics(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	pod := makeTestPod("lamorak-aaa", namespace, "lamorak", true, 0, time.Hour)
	if _, err := fakeK8sClient.CoreV1().Pods(namespace).Create(nil, pod, metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create pod: %v", err)
	}
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil,
		makeTestKnightCR("lamorak", namespace, "coding"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}

	// Serve metrics: register the PodMetrics list kind in the fake dynamic
	// client and create a usage entry, then turn the probe on.
	scheme := runtime.NewScheme()
	podMetricsList := &unstructured.UnstructuredList{}
	podMetricsList.SetGroupVersionKind(schema.GroupVersionKind{
		Group: "metrics.k8s.io", Version: "v1beta1", Kind: "PodMetricsList",
	})
	fakeDyn := fake.NewSimpleDynamicClientWithCustomListKinds(scheme,
		map[schema.GroupVersionResource]string{
			knightGVR:     "KnightList",
			podMetricsGVR: "PodMetricsList",
		})
	oldDynClient := dynClient
	dynClient = fakeDyn
	oldProbe := metricsProbe
	metricsProbe = func() bool { return true }
	t.Cleanup(func() {
		dynClient = oldDynClient
		metricsProbe = oldProbe
	})

	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil,
		makeTestKnightCR("lamorak", namespace, "coding"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}
	if _, err := dynClient.Resource(podMetricsGVR).Namespace(namespace).Create(nil,
		podMetrics("lamorak-aaa", namespace, "150m", "384Mi"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create pod metrics: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/fleet/lamorak", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var detail struct {
		KnightStatus
		Pods    []KnightPod    `json:"pods"`
		Scaling *KnightScaling `json:"scaling"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatalf("failed to parse detail response: %v", err)
	}

	if len(detail.Pods) != 1 {
		t.Fatalf("expected 1 pod, got %d", len(detail.Pods))
	}
	if detail.Pods[0].CPU != "150m" || detail.Pods[0].Memory != "384Mi" {
		t.Errorf("expected usage 150m/384Mi, got %s/%s", detail.Pods[0].CPU, detail.Pods[0].Memory)
	}
	if detail.Scaling == nil {
		t.Fatal("expected scaling block")
	}
	if detail.Scaling.Autoscaled {
		t.Error("a knight without a ScaledObject is not autoscaled")
	}
	if detail.Scaling.MinReplicas != 1 || detail.Scaling.MaxReplicas != 1 ||
		detail.Scaling.CurrentReplicas != 1 || detail.Scaling.ReadyReplicas != 1 {
		t.Errorf("unexpected scaling defaults: %+v", detail.Scaling)
	}
}

// TestKnightHandlerScalingFallback checks the ScaledObject/HPA fallback path
// when Knight.status.scaling is absent (older operator).
func TestKnightHandlerScalingFallback(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	scheme := runtime.NewScheme()
	fakeDyn := fake.NewSimpleDynamicClientWithCustomListKinds(scheme,
		map[schema.GroupVersionResource]string{
			knightGVR:       "KnightList",
			scaledObjectGVR: "ScaledObjectList",
		})
	oldDynClient := dynClient
	dynClient = fakeDyn
	t.Cleanup(func() { dynClient = oldDynClient })

	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil,
		makeTestKnightCR("gareth", namespace, "coding"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}
	so := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "keda.sh/v1alpha1",
			"kind":       "ScaledObject",
			"metadata": map[string]interface{}{
				"name":      "gareth",
				"namespace": namespace,
			},
			"spec": map[string]interface{}{
				"minReplicaCount": int64(1),
				"maxReplicaCount": int64(4),
			},
		},
	}
	if _, err := dynClient.Resource(scaledObjectGVR).Namespace(namespace).Create(nil, so, metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create ScaledObject: %v", err)
	}
	hpa := &autoscalingv2.HorizontalPodAutoscaler{
		ObjectMeta: metav1.ObjectMeta{Name: "keda-hpa-gareth", Namespace: namespace},
		Status:     autoscalingv2.HorizontalPodAutoscalerStatus{DesiredReplicas: 2},
	}
	if _, err := fakeK8sClient.AutoscalingV2().HorizontalPodAutoscalers(namespace).Create(nil, hpa, metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create HPA: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/fleet/gareth", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var detail struct {
		Scaling *KnightScaling `json:"scaling"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatalf("failed to parse detail response: %v", err)
	}
	if detail.Scaling == nil {
		t.Fatal("expected scaling block")
	}
	if !detail.Scaling.Autoscaled {
		t.Error("expected autoscaled=true via ScaledObject fallback")
	}
	if detail.Scaling.MinReplicas != 1 || detail.Scaling.MaxReplicas != 4 {
		t.Errorf("expected bounds 1/4 from ScaledObject, got %d/%d",
			detail.Scaling.MinReplicas, detail.Scaling.MaxReplicas)
	}
	if detail.Scaling.DesiredReplicas == nil || *detail.Scaling.DesiredReplicas != 2 {
		t.Errorf("expected desired 2 from HPA, got %v", detail.Scaling.DesiredReplicas)
	}
}

// TestListPodMetricsNoAPI checks the graceful fallback: without metrics.k8s.io
// served the handler still returns pods without usage fields.
func TestListPodMetricsNoAPI(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	pod := makeTestPod("dagonet-aaa", namespace, "dagonet", true, 0, time.Hour)
	if _, err := fakeK8sClient.CoreV1().Pods(namespace).Create(nil, pod, metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create pod: %v", err)
	}
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil,
		makeTestKnightCR("dagonet", namespace, "coding"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}

	knights := fleetResponse(t, router)
	k := knightByName(t, knights, "dagonet")

	if len(k.Pods) != 1 {
		t.Fatalf("expected 1 pod, got %d", len(k.Pods))
	}
	if k.Pods[0].CPU != "" || k.Pods[0].Memory != "" {
		t.Errorf("expected no usage fields, got %s/%s", k.Pods[0].CPU, k.Pods[0].Memory)
	}
	if k.Pods[0].CPURequest != "100m" {
		t.Errorf("requests still shown without metrics API, got %q", k.Pods[0].CPURequest)
	}
}
