package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/mux"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

const logsTestNS = "test-namespace"

func makeKnightPod(knight, name string, ready bool, started time.Time, prevTerminated bool) *corev1.Pod {
	cs := corev1.ContainerStatus{Name: "knight", Ready: ready}
	if prevTerminated {
		cs.RestartCount = 2
		cs.LastTerminationState.Terminated = &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}
	}
	st := metav1.NewTime(started)
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: logsTestNS,
			Labels: map[string]string{
				"app.kubernetes.io/name":     "knight",
				"app.kubernetes.io/instance": knight,
			},
			CreationTimestamp: st,
		},
		Spec: corev1.PodSpec{
			NodeName:       "node-1",
			Containers:     []corev1.Container{{Name: "knight"}, {Name: "nats-sidecar"}},
			InitContainers: []corev1.Container{{Name: "init-skills"}},
		},
		Status: corev1.PodStatus{
			Phase:             corev1.PodRunning,
			StartTime:         &st,
			ContainerStatuses: []corev1.ContainerStatus{cs},
		},
	}
}

// setupLogsRouter seeds three galahad replicas and one pod of another knight.
func setupLogsRouter(t *testing.T, reg *runningRegistry) (*mux.Router, *k8sfake.Clientset) {
	t.Helper()
	now := time.Now()
	fc := k8sfake.NewSimpleClientset(
		makeKnightPod("galahad", "galahad-aaa-1", true, now.Add(-3*time.Hour), false),
		makeKnightPod("galahad", "galahad-aaa-2", true, now.Add(-1*time.Hour), true),
		makeKnightPod("galahad", "galahad-aaa-3", false, now.Add(-1*time.Minute), false),
		makeKnightPod("lancelot", "lancelot-bbb-1", true, now, false),
	)
	k8sClient = fc
	r := mux.NewRouter()
	r.HandleFunc("/api/fleet/{knight}/logs", knightLogsHandler(logsTestNS)).Methods("GET")
	r.HandleFunc("/api/fleet/{knight}/pods", knightPodsHandler(logsTestNS, reg)).Methods("GET")
	return r, fc
}

// lastLogOptions returns the PodLogOptions of the last GetLogs call.
func lastLogOptions(fc *k8sfake.Clientset) *corev1.PodLogOptions {
	var opts *corev1.PodLogOptions
	for _, a := range fc.Actions() {
		if g, ok := a.(k8stesting.GenericAction); ok && a.GetSubresource() == "log" {
			opts, _ = g.GetValue().(*corev1.PodLogOptions)
		}
	}
	return opts
}

func doGet(r http.Handler, url string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", url, nil))
	return w
}

func TestKnightLogs_SelectedPod(t *testing.T) {
	r, fc := setupLogsRouter(t, nil)
	for _, pod := range []string{"galahad-aaa-1", "galahad-aaa-2", "galahad-aaa-3"} {
		w := doGet(r, "/api/fleet/galahad/logs?pod="+pod)
		if w.Code != http.StatusOK {
			t.Fatalf("pod %s: status %d: %s", pod, w.Code, w.Body.String())
		}
		if got := w.Header().Get("X-Pod-Name"); got != pod {
			t.Errorf("X-Pod-Name = %q, want %q", got, pod)
		}
		if w.Body.String() != "fake logs" {
			t.Errorf("body = %q", w.Body.String())
		}
	}
	opts := lastLogOptions(fc)
	if opts == nil || opts.TailLines == nil || *opts.TailLines != knightLogTailLines {
		t.Errorf("tail lines not kept: %+v", opts)
	}
	if opts.Previous || opts.Container != "" {
		t.Errorf("unexpected options %+v", opts)
	}
}

func TestKnightLogs_DefaultPodIsNewestReady(t *testing.T) {
	r, _ := setupLogsRouter(t, nil)
	w := doGet(r, "/api/fleet/galahad/logs")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if got := w.Header().Get("X-Pod-Name"); got != "galahad-aaa-2" {
		t.Errorf("default pod = %q, want galahad-aaa-2", got)
	}
}

func TestKnightLogs_UnknownPodRejected(t *testing.T) {
	r, fc := setupLogsRouter(t, nil)
	for _, pod := range []string{"lancelot-bbb-1", "galahad-zzz-9"} {
		fc.ClearActions()
		w := doGet(r, "/api/fleet/galahad/logs?pod="+pod)
		if w.Code != http.StatusNotFound {
			t.Errorf("pod %s: status %d, want 404", pod, w.Code)
		}
		if lastLogOptions(fc) != nil {
			t.Errorf("pod %s: logs were read", pod)
		}
	}
	if w := doGet(r, "/api/fleet/galahad/logs?pod=Bad_Pod"); w.Code != http.StatusBadRequest {
		t.Errorf("invalid pod name: status %d, want 400", w.Code)
	}
}

func TestKnightLogs_ContainerValidated(t *testing.T) {
	r, fc := setupLogsRouter(t, nil)
	w := doGet(r, "/api/fleet/galahad/logs?pod=galahad-aaa-1&container=nats-sidecar")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if opts := lastLogOptions(fc); opts == nil || opts.Container != "nats-sidecar" {
		t.Errorf("container not passed: %+v", opts)
	}
	if w := doGet(r, "/api/fleet/galahad/logs?pod=galahad-aaa-1&container=init-skills"); w.Code != http.StatusOK {
		t.Errorf("init container: status %d", w.Code)
	}
	fc.ClearActions()
	if w := doGet(r, "/api/fleet/galahad/logs?pod=galahad-aaa-1&container=other"); w.Code != http.StatusBadRequest {
		t.Errorf("unknown container: status %d, want 400", w.Code)
	}
	if lastLogOptions(fc) != nil {
		t.Error("logs read for unknown container")
	}
	if w := doGet(r, "/api/fleet/galahad/logs?container=Bad%20Name"); w.Code != http.StatusBadRequest {
		t.Errorf("invalid container: status %d, want 400", w.Code)
	}
}

func TestKnightLogs_PreviousAndTimestamps(t *testing.T) {
	r, fc := setupLogsRouter(t, nil)
	w := doGet(r, "/api/fleet/galahad/logs?pod=galahad-aaa-2&previous=true&timestamps=true")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	opts := lastLogOptions(fc)
	if opts == nil || !opts.Previous || !opts.Timestamps {
		t.Errorf("previous/timestamps not passed: %+v", opts)
	}
	if w := doGet(r, "/api/fleet/galahad/logs?previous=maybe"); w.Code != http.StatusBadRequest {
		t.Errorf("invalid previous: status %d, want 400", w.Code)
	}
	if w := doGet(r, "/api/fleet/galahad/logs?timestamps=x"); w.Code != http.StatusBadRequest {
		t.Errorf("invalid timestamps: status %d, want 400", w.Code)
	}
}

func TestKnightLogs_KnightWithoutPods(t *testing.T) {
	r, _ := setupLogsRouter(t, nil)
	if w := doGet(r, "/api/fleet/percival/logs"); w.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404", w.Code)
	}
	if w := doGet(r, "/api/fleet/Bad_Name/logs"); w.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", w.Code)
	}
}

func TestKnightPods_ListAndDefault(t *testing.T) {
	r, _ := setupLogsRouter(t, nil)
	w := doGet(r, "/api/fleet/galahad/pods")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var resp knightPodsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Pods) != 3 {
		t.Fatalf("got %d pods, want 3 (other knights' pods excluded)", len(resp.Pods))
	}
	want := []string{"galahad-aaa-2", "galahad-aaa-1", "galahad-aaa-3"}
	for i, p := range resp.Pods {
		if p.Name != want[i] {
			t.Errorf("pods[%d] = %s, want %s", i, p.Name, want[i])
		}
	}
	if resp.Default != "galahad-aaa-2" {
		t.Errorf("default = %s", resp.Default)
	}
	p := resp.Pods[0]
	if p.Restarts != 2 || len(p.Containers) != 2 || !p.Containers[0].HasPrevious || p.Containers[1].HasPrevious {
		t.Errorf("unexpected pod info %+v", p)
	}
}

func TestKnightPods_DefaultIsMostRecentActivity(t *testing.T) {
	reg := newRunningRegistry(100, time.Minute)
	reg.apply(activityEvent{Type: "task.started", Knight: "galahad", Pod: "galahad-aaa-3", TaskID: "t1", Timestamp: time.Now().UTC().Format(time.RFC3339Nano)})
	r, _ := setupLogsRouter(t, reg)
	var resp knightPodsResponse
	if err := json.Unmarshal(doGet(r, "/api/fleet/galahad/pods").Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Default != "galahad-aaa-3" {
		t.Errorf("default = %s, want galahad-aaa-3 (active pod)", resp.Default)
	}
	if resp.Pods[0].LastActivity == nil {
		t.Error("lastActivity not set on active pod")
	}
}

func TestKnightPods_Empty(t *testing.T) {
	r, _ := setupLogsRouter(t, nil)
	w := doGet(r, "/api/fleet/percival/pods")
	if w.Code != http.StatusOK || w.Body.String() != "{\"pods\":[]}\n" {
		t.Errorf("status %d body %q", w.Code, w.Body.String())
	}
}
