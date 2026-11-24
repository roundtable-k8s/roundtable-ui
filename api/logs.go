package main

// Per-pod log streaming (#218, part of #186). A knight may run several
// replicas, so the logs endpoint takes the pod to read from (validated against
// the knight's own pods) plus an optional container and previous=true for the
// logs of the last crashed container. GET /api/fleet/{knight}/pods lists the
// pods for the drawer's picker and names the default pod.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	knightLogTailLines = int64(100)
	knightLogMaxBytes  = 1 << 20
	knightLogTimeout   = 15 * time.Second
)

// PodContainerInfo is one container of a knight pod.
type PodContainerInfo struct {
	Name         string `json:"name"`
	Ready        bool   `json:"ready"`
	RestartCount int32  `json:"restartCount"`
	// HasPrevious is true when the container has a terminated previous
	// instance, i.e. previous=true has logs to show.
	HasPrevious bool `json:"hasPrevious"`
}

// KnightPodInfo is one pod of a knight as served by GET /api/fleet/{knight}/pods.
type KnightPodInfo struct {
	Name         string             `json:"name"`
	Phase        string             `json:"phase"`
	Ready        bool               `json:"ready"`
	Node         string             `json:"node,omitempty"`
	StartTime    *time.Time         `json:"startTime,omitempty"`
	Restarts     int32              `json:"restarts"`
	Containers   []PodContainerInfo `json:"containers"`
	LastActivity *time.Time         `json:"lastActivity,omitempty"`
}

type knightPodsResponse struct {
	Pods []KnightPodInfo `json:"pods"`
	// Default is the pod the drawer should select first: the pod with the
	// most recent task activity, else the newest ready pod.
	Default string `json:"default,omitempty"`
}

// listPodsOfKnight returns the knight's own pods (selected by the operator's
// instance label, so another knight's pods are never included).
func listPodsOfKnight(ctx context.Context, namespace, knight string) ([]corev1.Pod, error) {
	pods, err := k8sClient.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("app.kubernetes.io/name=knight,app.kubernetes.io/instance=%s", knight),
	})
	if err != nil {
		return nil, err
	}
	return pods.Items, nil
}

// lastActivityByPod returns, per pod, the most recent event time of the
// knight's in-flight tasks.
func lastActivityByPod(reg *runningRegistry, knight string) map[string]time.Time {
	out := map[string]time.Time{}
	if reg == nil {
		return out
	}
	for _, t := range reg.snapshot() {
		if t.Knight != knight || t.Pod == "" {
			continue
		}
		if t.LastEventAt.After(out[t.Pod]) {
			out[t.Pod] = t.LastEventAt
		}
	}
	return out
}

func podStartTime(p *corev1.Pod) time.Time {
	if p.Status.StartTime != nil {
		return p.Status.StartTime.Time
	}
	return p.CreationTimestamp.Time
}

// sortLogPods orders pods for the picker and returns them: most recent
// activity first, then ready before not ready, then newest first, then name.
func sortLogPods(pods []corev1.Pod, activity map[string]time.Time) []corev1.Pod {
	out := append([]corev1.Pod(nil), pods...)
	sort.SliceStable(out, func(i, j int) bool {
		ai, aj := activity[out[i].Name], activity[out[j].Name]
		if !ai.Equal(aj) {
			return ai.After(aj)
		}
		ri, rj := podIsReady(&out[i]), podIsReady(&out[j])
		if ri != rj {
			return ri
		}
		si, sj := podStartTime(&out[i]), podStartTime(&out[j])
		if !si.Equal(sj) {
			return si.After(sj)
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func buildKnightPodInfo(p *corev1.Pod, activity map[string]time.Time) KnightPodInfo {
	info := KnightPodInfo{
		Name:       p.Name,
		Phase:      string(p.Status.Phase),
		Ready:      podIsReady(p),
		Node:       p.Spec.NodeName,
		Containers: []PodContainerInfo{},
	}
	if st := podStartTime(p); !st.IsZero() {
		info.StartTime = &st
	}
	if at, ok := activity[p.Name]; ok {
		info.LastActivity = &at
	}
	statuses := map[string]corev1.ContainerStatus{}
	for _, cs := range p.Status.ContainerStatuses {
		statuses[cs.Name] = cs
	}
	for _, c := range p.Spec.Containers {
		cs := statuses[c.Name]
		info.Restarts += cs.RestartCount
		info.Containers = append(info.Containers, PodContainerInfo{
			Name:         c.Name,
			Ready:        cs.Ready,
			RestartCount: cs.RestartCount,
			HasPrevious:  cs.LastTerminationState.Terminated != nil,
		})
	}
	return info
}

func knightPodsHandler(namespace string, reg *runningRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := mux.Vars(r)["knight"]
		if !validK8sName.MatchString(name) {
			http.Error(w, "Invalid knight name", http.StatusBadRequest)
			return
		}
		if k8sClient == nil {
			http.Error(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}
		pods, err := listPodsOfKnight(r.Context(), namespace, name)
		if err != nil {
			slog.Error("List knight pods failed", "knight", name, "error", err)
			http.Error(w, "Failed to list pods", http.StatusInternalServerError)
			return
		}
		activity := lastActivityByPod(reg, name)
		resp := knightPodsResponse{Pods: []KnightPodInfo{}}
		for _, p := range sortLogPods(pods, activity) {
			resp.Pods = append(resp.Pods, buildKnightPodInfo(&p, activity))
		}
		if len(resp.Pods) > 0 {
			resp.Default = resp.Pods[0].Name
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

// parseBoolParam parses an optional boolean query parameter (absent = false).
func parseBoolParam(r *http.Request, key string) (bool, error) {
	v := r.URL.Query().Get(key)
	if v == "" {
		return false, nil
	}
	return strconv.ParseBool(v)
}

func podHasContainer(p *corev1.Pod, container string) bool {
	for _, c := range p.Spec.Containers {
		if c.Name == container {
			return true
		}
	}
	for _, c := range p.Spec.InitContainers {
		if c.Name == container {
			return true
		}
	}
	return false
}

// knightLogsHandler serves GET /api/fleet/{knight}/logs. Query params:
//   - pod: one of the knight's own pods (default: the newest ready pod)
//   - container: a container of that pod (default: the pod's default container)
//   - previous=true: logs of the previous (crashed) container instance
//   - timestamps=true: prefix each line with its RFC3339 timestamp, so the UI
//     can merge several pods' streams in order
//
// The pod actually read is echoed in the X-Pod-Name response header.
func knightLogsHandler(namespace string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := mux.Vars(r)["knight"]
		if !validK8sName.MatchString(name) {
			http.Error(w, "Invalid knight name", http.StatusBadRequest)
			return
		}

		q := r.URL.Query()
		podName := q.Get("pod")
		if podName != "" && !validPodName(podName) {
			http.Error(w, "Invalid pod name", http.StatusBadRequest)
			return
		}
		container := q.Get("container")
		if container != "" && !validK8sName.MatchString(container) {
			http.Error(w, "Invalid container name", http.StatusBadRequest)
			return
		}
		previous, err := parseBoolParam(r, "previous")
		if err != nil {
			http.Error(w, "Invalid previous value (want true or false)", http.StatusBadRequest)
			return
		}
		timestamps, err := parseBoolParam(r, "timestamps")
		if err != nil {
			http.Error(w, "Invalid timestamps value (want true or false)", http.StatusBadRequest)
			return
		}

		if k8sClient == nil {
			http.Error(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}

		pods, err := listPodsOfKnight(r.Context(), namespace, name)
		if err != nil || len(pods) == 0 {
			http.Error(w, "Knight not found", http.StatusNotFound)
			return
		}

		// Only the knight's own pods may be read: the pod must be in the
		// label-selected list, never fetched by name directly.
		var pod *corev1.Pod
		if podName == "" {
			sorted := sortLogPods(pods, nil)
			pod = &sorted[0]
		} else {
			for i := range pods {
				if pods[i].Name == podName {
					pod = &pods[i]
					break
				}
			}
			if pod == nil {
				http.Error(w, "Pod not found for this knight", http.StatusNotFound)
				return
			}
		}
		if container != "" && !podHasContainer(pod, container) {
			http.Error(w, "Container not found in pod", http.StatusBadRequest)
			return
		}

		// Timeout prevents indefinite streaming (#55)
		ctx, cancel := context.WithTimeout(r.Context(), knightLogTimeout)
		defer cancel()

		lines := knightLogTailLines
		req := k8sClient.CoreV1().Pods(namespace).GetLogs(pod.Name, &corev1.PodLogOptions{
			Container:  container,
			Previous:   previous,
			Timestamps: timestamps,
			TailLines:  &lines,
		})
		stream, err := req.Stream(ctx)
		if err != nil {
			slog.Error("Log stream error", "knight", name, "pod", pod.Name, "previous", previous, "error", err)
			if previous && apierrors.IsBadRequest(err) {
				// The API server answers 400 when there is no previous
				// terminated container to read.
				http.Error(w, "No previous container logs for this pod", http.StatusNotFound)
				return
			}
			http.Error(w, "Failed to read logs", http.StatusInternalServerError)
			return
		}
		defer stream.Close()

		// Redact the (size-capped) log tail before it leaves the API (#188).
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Pod-Name", pod.Name)
		raw, _ := io.ReadAll(io.LimitReader(stream, knightLogMaxBytes))
		w.Write([]byte(redactSecrets(string(raw))))
	}
}
