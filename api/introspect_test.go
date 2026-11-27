package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// fakeIntrospect records requests and answers per subject.
type fakeIntrospect struct {
	mu       sync.Mutex
	subjects []string
	payloads []map[string]interface{}
	answer   func(subject string) ([]byte, error)
}

func (f *fakeIntrospect) requester() introspectRequester {
	return func(subject string, data []byte, _ time.Duration) ([]byte, error) {
		var p map[string]interface{}
		_ = json.Unmarshal(data, &p)
		f.mu.Lock()
		f.subjects = append(f.subjects, subject)
		f.payloads = append(f.payloads, p)
		f.mu.Unlock()
		return f.answer(subject)
	}
}

func (f *fakeIntrospect) asked(subject string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, s := range f.subjects {
		if s == subject {
			return true
		}
	}
	return false
}

func makeKnightPod(name, knight string, ready bool) *corev1.Pod {
	status := corev1.ConditionFalse
	if ready {
		status = corev1.ConditionTrue
	}
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: "test-namespace",
			Labels:    map[string]string{"app.kubernetes.io/name": "knight", "app.kubernetes.io/instance": knight},
		},
		Status: corev1.PodStatus{
			Phase:      corev1.PodRunning,
			Conditions: []corev1.PodCondition{{Type: corev1.PodReady, Status: status}},
		},
	}
}

// setupIntrospectTest creates a Ready galahad CR (prefix fleet-a) with the
// given pods and installs the fake requester.
func setupIntrospectTest(t *testing.T, f *fakeIntrospect, pods ...*corev1.Pod) http.Handler {
	t.Helper()
	router := setupTestRouter()
	t.Setenv("NAMESPACE", "test-namespace")
	cr := makeTestKnightCR("galahad", "test-namespace", "security")
	cr.Object["spec"].(map[string]interface{})["nats"] = map[string]interface{}{
		"subjects": []interface{}{"fleet-a.tasks.security.>"},
	}
	if _, err := dynClient.Resource(knightGVR).Namespace("test-namespace").Create(context.Background(), cr, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create CR: %v", err)
	}
	for _, p := range pods {
		if _, err := fakeK8sClient.CoreV1().Pods("test-namespace").Create(context.Background(), p, metav1.CreateOptions{}); err != nil {
			t.Fatalf("create pod: %v", err)
		}
	}
	orig := sessionRequester
	sessionRequester = func(context.Context) introspectRequester { return f.requester() }
	t.Cleanup(func() { sessionRequester = orig })
	return router
}

func doSession(t *testing.T, h http.Handler, query string) (*httptest.ResponseRecorder, map[string]interface{}) {
	t.Helper()
	req := httptest.NewRequest("GET", "/api/fleet/galahad/session?"+query, nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var body map[string]interface{}
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("invalid JSON %q: %v", w.Body.String(), err)
		}
	}
	return w, body
}

func statsReply(pod string, msgs, cost, uptime, active float64, model string) []byte {
	b, _ := json.Marshal(map[string]interface{}{
		"knight": "Galahad", "pod": pod, "node": "node-" + pod,
		"session": map[string]interface{}{
			"sessionId": "s-" + pod, "userMessages": msgs, "assistantMessages": msgs, "toolCalls": 1.0,
			"totalMessages": 2 * msgs, "tokens": map[string]interface{}{"input": 10.0, "output": 5.0, "total": 15.0}, "cost": cost,
		},
		"runtime":  map[string]interface{}{"uptime": uptime, "activeTasks": active, "model": model},
		"inflight": []interface{}{map[string]interface{}{"taskId": "t-" + pod}},
	})
	return b
}

func TestIntrospectStatsFanOutAggregates(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		switch s {
		case "fleet-a.introspect.Galahad.galahad-a":
			return statsReply("galahad-a", 2, 0.5, 100, 1, "opus"), nil
		case "fleet-a.introspect.Galahad.galahad-b":
			return statsReply("galahad-b", 3, 0.25, 300, 2, "opus"), nil
		}
		t.Errorf("unexpected subject %s", s)
		return nil, nats.ErrTimeout
	}}
	h := setupIntrospectTest(t, f,
		makeKnightPod("galahad-b", "galahad", true),
		makeKnightPod("galahad-a", "galahad", true),
		makeKnightPod("galahad-c", "galahad", false),  // not ready: skipped
		makeKnightPod("lancelot-a", "lancelot", true), // other knight: skipped
	)

	w, body := doSession(t, h, "type=stats")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if got := w.Header().Get(introspectScopeHeader); got != "aggregate" {
		t.Errorf("scope = %q, want aggregate", got)
	}
	if f.asked("fleet-a.introspect.Galahad") {
		t.Error("knight-level subject must not be used when pods answer")
	}
	sess := body["session"].(map[string]interface{})
	if sess["totalMessages"] != 10.0 || sess["cost"] != 0.75 || sess["toolCalls"] != 2.0 {
		t.Errorf("session totals wrong: %v", sess)
	}
	if tok := sess["tokens"].(map[string]interface{}); tok["total"] != 30.0 {
		t.Errorf("token total = %v, want 30", tok["total"])
	}
	rt := body["runtime"].(map[string]interface{})
	if rt["activeTasks"] != 3.0 || rt["uptime"] != 300.0 || rt["model"] != "opus" {
		t.Errorf("runtime wrong: %v", rt)
	}
	inflight := body["inflight"].([]interface{})
	if len(inflight) != 2 || inflight[0].(map[string]interface{})["pod"] != "galahad-a" {
		t.Errorf("inflight not concatenated/tagged: %v", inflight)
	}
	if body["podCount"] != 2.0 || body["respondedPods"] != 2.0 {
		t.Errorf("pod counts wrong: %v/%v", body["podCount"], body["respondedPods"])
	}
	if _, has := body["pod"]; has {
		t.Error("aggregate must not claim a single pod")
	}
	pods := body["pods"].([]interface{})
	if len(pods) != 2 {
		t.Fatalf("breakdown len = %d", len(pods))
	}
	a := pods[0].(map[string]interface{})
	if a["pod"] != "galahad-a" || a["ok"] != true {
		t.Errorf("breakdown[0] = %v", a)
	}
	// Breakdown keeps the pod's own (unsummed) values.
	if a["stats"].(map[string]interface{})["session"].(map[string]interface{})["totalMessages"] != 4.0 {
		t.Errorf("breakdown mutated by aggregation: %v", a["stats"])
	}
}

func TestIntrospectStatsPartialTimeout(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if strings.HasSuffix(s, ".galahad-b") {
			return nil, nats.ErrTimeout
		}
		return statsReply("galahad-a", 2, 0.5, 100, 1, "opus"), nil
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-b", "galahad", true))

	w, body := doSession(t, h, "type=stats")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if body["respondedPods"] != 1.0 || body["podCount"] != 2.0 {
		t.Errorf("counts = %v/%v", body["respondedPods"], body["podCount"])
	}
	if body["session"].(map[string]interface{})["totalMessages"] != 4.0 {
		t.Errorf("totals should cover the answering pod only: %v", body["session"])
	}
	b := body["pods"].([]interface{})[1].(map[string]interface{})
	if b["pod"] != "galahad-b" || b["ok"] != false || b["error"] != "timeout" {
		t.Errorf("timed-out pod breakdown = %v", b)
	}
}

func TestIntrospectStatsAllTimeoutIs504(t *testing.T) {
	f := &fakeIntrospect{answer: func(string) ([]byte, error) { return nil, nats.ErrTimeout }}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-b", "galahad", true))
	if w, _ := doSession(t, h, "type=stats"); w.Code != http.StatusGatewayTimeout {
		t.Errorf("status = %d, want 504", w.Code)
	}
}

func TestIntrospectFallsBackToKnightSubjectForOlderRuntime(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if s == "fleet-a.introspect.Galahad" {
			return []byte(`{"knight":"Galahad","session":null}`), nil
		}
		return nil, nats.ErrNoResponders
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true))
	w, body := doSession(t, h, "type=stats")
	if w.Code != http.StatusOK || body["knight"] != "Galahad" {
		t.Fatalf("status %d body %v", w.Code, body)
	}
	if got := w.Header().Get(introspectScopeHeader); got != "pod" {
		t.Errorf("scope = %q, want pod for a one-pod knight", got)
	}
}

func TestIntrospectFallbackScopeKnightForSeveralPods(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if s == "fleet-a.introspect.Galahad" {
			return []byte(`{"knight":"Galahad","session":null}`), nil
		}
		return nil, nats.ErrNoResponders
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-b", "galahad", true))
	w, _ := doSession(t, h, "type=stats")
	if got := w.Header().Get(introspectScopeHeader); w.Code != http.StatusOK || got != "knight" {
		t.Errorf("status %d scope = %q, want 200 knight", w.Code, got)
	}
}

func TestIntrospectCancelledContextReturnsPromptly(t *testing.T) {
	h := setupIntrospectTest(t, &fakeIntrospect{}, makeKnightPod("galahad-a", "galahad", true))
	sessionRequester = func(ctx context.Context) introspectRequester {
		return func(string, []byte, time.Duration) ([]byte, error) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(30 * time.Second):
				return nil, nats.ErrTimeout
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("GET", "/api/fleet/galahad/session?type=stats", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { h.ServeHTTP(w, req); close(done) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("handler still waiting after the request context was cancelled")
	}
	if w.Code == http.StatusOK {
		t.Errorf("status = %d, want an error for a cancelled request", w.Code)
	}
}

func TestTagListWithPodNested(t *testing.T) {
	in := []interface{}{
		map[string]interface{}{
			"id":    "a",
			"items": []interface{}{map[string]interface{}{"n": 1.0}, map[string]interface{}{"n": 2.0, "pod": "keep"}},
			"meta":  map[string]interface{}{"runs": []interface{}{map[string]interface{}{"r": "x"}}},
		},
	}
	out := tagListWithPod(in, "p1")
	top := out[0].(map[string]interface{})
	if top["pod"] != "p1" {
		t.Errorf("top item pod = %v", top["pod"])
	}
	items := top["items"].([]interface{})
	if items[0].(map[string]interface{})["pod"] != "p1" || items[1].(map[string]interface{})["pod"] != "keep" {
		t.Errorf("nested items = %v", items)
	}
	runs := top["meta"].(map[string]interface{})["runs"].([]interface{})
	if runs[0].(map[string]interface{})["pod"] != "p1" {
		t.Errorf("nested-in-object list = %v", runs)
	}
	if _, has := in[0].(map[string]interface{})["pod"]; has {
		t.Error("input was mutated")
	}
}

func TestIntrospectNoPodsUsesKnightSubject(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if s != "fleet-a.introspect.Galahad" {
			t.Errorf("unexpected subject %s", s)
		}
		return []byte(`{"knight":"Galahad"}`), nil
	}}
	h := setupIntrospectTest(t, f)
	if w, _ := doSession(t, h, "type=stats"); w.Code != http.StatusOK {
		t.Errorf("status = %d", w.Code)
	}
}

func TestIntrospectPodParam(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if s == "fleet-a.introspect.Galahad.galahad-b" {
			return []byte(`{"id":"abc","entries":[]}`), nil
		}
		t.Errorf("only the selected pod may be asked, got %s", s)
		return nil, nats.ErrTimeout
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-b", "galahad", true))

	w, body := doSession(t, h, "type=session&id=abc&pod=galahad-b&runId=run-42")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if body["pod"] != "galahad-b" {
		t.Errorf("reply pod = %v, want galahad-b", body["pod"])
	}
	if got := w.Header().Get(introspectScopeHeader); got != "pod" {
		t.Errorf("scope = %q, want pod", got)
	}
	if p := f.payloads[0]; p["runId"] != "run-42" || p["id"] != "abc" || p["type"] != "session" {
		t.Errorf("payload = %v", p)
	}
}

func TestIntrospectPodParamRejected(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		t.Errorf("no request expected, got %s", s)
		return nil, nats.ErrTimeout
	}}
	h := setupIntrospectTest(t, f,
		makeKnightPod("galahad-a", "galahad", true),
		makeKnightPod("lancelot-a", "lancelot", true),
	)
	for _, tt := range []struct {
		query string
		want  int
	}{
		{"type=stats&pod=lancelot-a", http.StatusNotFound},          // another knight's pod
		{"type=stats&pod=galahad-7d9f5c6b8-zzzzz", http.StatusGone}, // galahad's naming, not ready: scaled away
		{"type=stats&pod=percival-a", http.StatusNotFound},
		{"type=stats&pod=galahad-a.>", http.StatusBadRequest},
		{"type=stats&pod=Galahad*", http.StatusBadRequest},
		{"type=history&runId=run%20x", http.StatusBadRequest},
		{"type=history&runId=a.%3E", http.StatusBadRequest},
	} {
		if w, _ := doSession(t, h, tt.query); w.Code != tt.want {
			t.Errorf("%s: status %d, want %d", tt.query, w.Code, tt.want)
		}
	}
}

func TestIntrospectPodParamOlderRuntimeMultiPod(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if s == "fleet-a.introspect.Galahad" {
			t.Error("knight-level subject would answer from a random pod")
		}
		return nil, nats.ErrNoResponders
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-b", "galahad", true))
	if w, _ := doSession(t, h, "type=stats&pod=galahad-a"); w.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", w.Code)
	}
}

func TestIntrospectSessionAnsweredByOwningPod(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if strings.HasSuffix(s, ".galahad-a") {
			return []byte(`{"error":"session not found"}`), nil
		}
		return []byte(`{"id":"abc","entries":[{"id":"e1"}]}`), nil
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-b", "galahad", true))
	for i := 0; i < 3; i++ {
		w, body := doSession(t, h, "type=session&id=abc")
		if w.Code != http.StatusOK || body["pod"] != "galahad-b" || body["error"] != nil {
			t.Fatalf("status %d body %v; want galahad-b's session", w.Code, body)
		}
	}
}

func TestIntrospectSessionNotFoundAnywhere(t *testing.T) {
	f := &fakeIntrospect{answer: func(string) ([]byte, error) { return []byte(`{"error":"session not found"}`), nil }}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-b", "galahad", true))
	w, body := doSession(t, h, "type=session&id=abc")
	if w.Code != http.StatusOK || body["error"] != "session not found" {
		t.Errorf("status %d body %v", w.Code, body)
	}
}

func TestIntrospectHistoryMergedWithPods(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if strings.HasSuffix(s, ".galahad-a") {
			return []byte(`{"sessions":[{"id":"a1","startedAt":"2026-11-24T10:00:00Z"}]}`), nil
		}
		return []byte(`{"sessions":[{"id":"b1","startedAt":"2026-11-24T11:00:00Z"},{"id":"b0","startedAt":"2026-11-24T09:00:00Z"}]}`), nil
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-b", "galahad", true))
	w, body := doSession(t, h, "type=history")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	sessions := body["sessions"].([]interface{})
	want := [][2]string{{"b1", "galahad-b"}, {"a1", "galahad-a"}, {"b0", "galahad-b"}}
	if len(sessions) != len(want) {
		t.Fatalf("sessions = %v", sessions)
	}
	for i, wv := range want {
		s := sessions[i].(map[string]interface{})
		if s["id"] != wv[0] || s["pod"] != wv[1] {
			t.Errorf("sessions[%d] = %v, want id=%s pod=%s", i, s, wv[0], wv[1])
		}
	}
}

func TestAggregateStatsNoAnswers(t *testing.T) {
	if _, ok := aggregateStats("galahad", []podReply{{Pod: "a", Err: nats.ErrTimeout}}); ok {
		t.Error("expected ok=false when no pod answered")
	}
}

func TestIntrospectPodGone(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		t.Errorf("no NATS request expected for a gone pod, got %s", s)
		return nil, nats.ErrTimeout
	}}
	// galahad-b still exists but is terminating/not ready; galahad-c was scaled away.
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true), makeKnightPod("galahad-7d9f5c6b8-bbbbb", "galahad", false))
	for _, pod := range []string{"galahad-7d9f5c6b8-bbbbb", "galahad-7d9f5c6b8-ccccc"} {
		w, _ := doSession(t, h, "type=session&id=abc&pod="+pod)
		if w.Code != http.StatusGone {
			t.Fatalf("%s: status = %d, want 410", pod, w.Code)
		}
		var body map[string]interface{}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s: invalid JSON %q: %v", pod, w.Body.String(), err)
		}
		if body["podGone"] != true || body["pod"] != pod {
			t.Errorf("%s: body = %v", pod, body)
		}
	}
}

func TestIntrospectPodGoneScaledToZero(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		t.Errorf("no NATS request expected, got %s", s)
		return nil, nats.ErrTimeout
	}}
	router := setupTestRouter()
	t.Setenv("NAMESPACE", "test-namespace")
	cr := makeTestKnightCR("galahad", "test-namespace", "security")
	cr.Object["status"] = map[string]interface{}{"phase": "Scaled", "ready": false}
	if _, err := dynClient.Resource(knightGVR).Namespace("test-namespace").Create(context.Background(), cr, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create CR: %v", err)
	}
	orig := sessionRequester
	sessionRequester = func(context.Context) introspectRequester { return f.requester() }
	t.Cleanup(func() { sessionRequester = orig })

	if w, _ := doSession(t, router, "type=session&id=abc&pod=galahad-7d9f5c6b8-x1y2z"); w.Code != http.StatusGone {
		t.Errorf("named pod on a scaled-to-zero knight: status = %d, want 410", w.Code)
	}
	// Without a pod the old "no data" shape stays.
	if w, body := doSession(t, router, "type=stats"); w.Code != http.StatusOK || len(body) != 0 {
		t.Errorf("no pod: status %d body %v, want 200 {}", w.Code, body)
	}
}

func TestReplyFound(t *testing.T) {
	tests := []struct {
		in   string
		want bool
	}{
		{`{"error": null}`, false},
		{`{}`, false},
		{`{"error": "boom"}`, false},
		{`{"error": ""}`, false},
		{`{"found": false}`, false},
		{`{"found": true}`, true},
		{`{"sessions": []}`, true},
		{`{"error": null, "stats": {}}`, true},
		{`{"error": false, "found": true}`, true},
		{`{"found": false, "sessions": []}`, false},
		{`not json`, false},
	}
	for _, tt := range tests {
		if got := replyFound([]byte(tt.in)); got != tt.want {
			t.Errorf("replyFound(%s) = %v, want %v", tt.in, got, tt.want)
		}
	}
}

func TestIntrospectPodParamNoResponderSinglePodScope(t *testing.T) {
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		if s == "fleet-a.introspect.Galahad" {
			return []byte(`{"knight":"Galahad"}`), nil
		}
		return nil, nats.ErrNoResponders
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true))
	w, _ := doSession(t, h, "type=stats&pod=galahad-a")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if got := w.Header().Get(introspectScopeHeader); got != "pod" {
		t.Errorf("scope = %q, want pod", got)
	}
}

func TestLooksLikeKnightPod(t *testing.T) {
	for _, tt := range []struct {
		knight, pod string
		want        bool
	}{
		{"foo", "foo-7d9f5c6b8-x1y2z", true},
		{"Foo", "foo-7d9f5c6b8-x1y2z", true},
		{"foo", "foo-bar-7d9f5c6b8-x1y2z", false}, // a pod of knight foo-bar
		{"foo-bar", "foo-bar-7d9f5c6b8-x1y2z", true},
		{"foo", "foo-7d9f5c6b8", false},
		{"foo", "foo-", false},
		{"foo", "foobar-7d9f5c6b8-x1y2z", false},
		{"foo", "bar-7d9f5c6b8-x1y2z", false},
	} {
		if got := looksLikeKnightPod(tt.knight, tt.pod); got != tt.want {
			t.Errorf("looksLikeKnightPod(%q, %q) = %v, want %v", tt.knight, tt.pod, got, tt.want)
		}
	}
}

func TestIntrospectClientDisconnectNotLoggedAsTimeout(t *testing.T) {
	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := setupIntrospectTest(t, &fakeIntrospect{}) // no pods: knight-level path
	ctx, cancel := context.WithCancel(context.Background())
	sessionRequester = func(context.Context) introspectRequester {
		return func(string, []byte, time.Duration) ([]byte, error) {
			cancel()
			return nil, context.Canceled
		}
	}
	req := httptest.NewRequest("GET", "/api/fleet/galahad/session?type=stats", nil).WithContext(ctx)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code == http.StatusGatewayTimeout {
		t.Errorf("status = 504 for a cancelled request")
	}
	if strings.Contains(buf.String(), "introspect timeout") {
		t.Errorf("cancellation logged as timeout: %s", buf.String())
	}
}

func TestIntrospectRealTimeoutStill504(t *testing.T) {
	f := &fakeIntrospect{answer: func(string) ([]byte, error) { return nil, nats.ErrTimeout }}
	h := setupIntrospectTest(t, f)
	if w, _ := doSession(t, h, "type=stats"); w.Code != http.StatusGatewayTimeout {
		t.Errorf("status = %d, want 504", w.Code)
	}
}
