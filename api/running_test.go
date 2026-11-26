package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// fakeClock is a settable clock for the registry.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time      { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) add(d time.Duration) { c.mu.Lock(); c.t = c.t.Add(d); c.mu.Unlock() }

func newTestRegistry(max int) (*runningRegistry, *fakeClock) {
	clk := &fakeClock{t: time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)}
	reg := newRunningRegistry(max, 10*time.Second)
	reg.now = clk.now
	return reg, clk
}

// activity builds a raw activity event.
func activity(t *testing.T, typ, taskID string, seq int64, extra map[string]any) []byte {
	t.Helper()
	ev := map[string]any{
		"v": 1, "type": typ, "ts": "2026-11-24T12:00:00.000Z",
		"knight": "Galahad", "pod": "galahad-abc-1", "node": "node-1",
		"taskId": taskID, "runId": "run-1", "chainName": "pr-pipeline", "stepName": "implement",
		"model": "claude-opus-5-5", "seq": seq,
	}
	for k, v := range extra {
		ev[k] = v
	}
	b, err := json.Marshal(ev)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// recorder collects deltas.
type recorder struct {
	mu     sync.Mutex
	deltas []RunningDelta
}

func (r *recorder) fn(d RunningDelta) { r.mu.Lock(); r.deltas = append(r.deltas, d); r.mu.Unlock() }
func (r *recorder) ops() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.deltas))
	for i, d := range r.deltas {
		out[i] = d.Op
		if d.Op == "remove" {
			out[i] += ":" + d.Reason
		} else if d.Task != nil {
			out[i] += ":" + d.Task.Status
		}
	}
	return out
}

func TestRunningStartHeartbeatFinish(t *testing.T) {
	reg, clk := newTestRegistry(10)
	rec := &recorder{}
	unsub := reg.subscribe(rec.fn)
	defer unsub()

	reg.handleActivity(activity(t, "task.started", "t1", 1, map[string]any{"slot": 2, "concurrency": 4, "queuedFor": 1500}), "Galahad")
	got, ok := reg.get("t1")
	if !ok {
		t.Fatal("task.started did not create an entry")
	}
	if got.Status != runningStatusRunning || got.Knight != "Galahad" || got.Pod != "galahad-abc-1" ||
		got.RunID != "run-1" || got.ChainName != "pr-pipeline" || got.StepName != "implement" ||
		got.Slot == nil || *got.Slot != 2 || got.Concurrency == nil || *got.Concurrency != 4 ||
		got.QueuedForMs == nil || *got.QueuedForMs != 1500 || got.Source != "activity" {
		t.Fatalf("unexpected entry after start: %+v", got)
	}

	clk.add(10 * time.Second)
	reg.handleActivity(activity(t, "task.heartbeat", "t1", 2, map[string]any{
		"ts": "2026-11-24T12:00:10.000Z", "turns": 3, "inputTokens": 1000, "outputTokens": 200, "costUsd": 0.12, "currentTool": "Bash",
	}), "Galahad")
	reg.handleActivity(activity(t, "tool.started", "t1", 3, map[string]any{"tool": "Read", "toolCallId": "c1", "argsSummary": strings.Repeat("x", 300)}), "Galahad")
	reg.handleActivity(activity(t, "tool.finished", "t1", 4, map[string]any{"tool": "Read", "toolCallId": "c1", "durationMs": 42, "isError": false}), "Galahad")

	got, _ = reg.get("t1")
	if got.Turns == nil || *got.Turns != 3 || got.CostUSD == nil || *got.CostUSD != 0.12 ||
		got.InputTokens == nil || *got.InputTokens != 1000 || got.LastHeartbeatAt == nil {
		t.Fatalf("heartbeat counters not applied: %+v", got)
	}
	if got.LastTool == nil || got.LastTool.Type != "tool.finished" || got.LastTool.Tool != "Read" ||
		got.LastTool.DurationMs == nil || *got.LastTool.DurationMs != 42 {
		t.Fatalf("last tool event not held: %+v", got.LastTool)
	}
	if got.Seq != 4 {
		t.Fatalf("seq = %d, want 4", got.Seq)
	}

	// A reordered older event is ignored.
	reg.handleActivity(activity(t, "tool.started", "t1", 3, map[string]any{"tool": "Old"}), "Galahad")
	if got, _ = reg.get("t1"); got.LastTool.Tool != "Read" {
		t.Fatalf("reordered event overwrote the last tool: %+v", got.LastTool)
	}

	reg.handleActivity(activity(t, "task.finished", "t1", 5, map[string]any{"success": true}), "Galahad")
	if _, ok := reg.get("t1"); ok {
		t.Fatal("task.finished did not remove the entry")
	}
	// A late heartbeat of a finished task must not resurrect it.
	reg.handleActivity(activity(t, "task.heartbeat", "t1", 6, nil), "Galahad")
	if _, ok := reg.get("t1"); ok {
		t.Fatal("late heartbeat resurrected a finished task")
	}

	want := []string{"snapshot", "upsert:running", "upsert:running", "upsert:running", "upsert:running", "remove:finished"}
	if fmt.Sprint(rec.ops()) != fmt.Sprint(want) {
		t.Fatalf("deltas = %v, want %v", rec.ops(), want)
	}
}

func TestRunningArgsSummaryIsBounded(t *testing.T) {
	reg, _ := newTestRegistry(10)
	reg.handleActivity(activity(t, "tool.started", "t1", 1, map[string]any{"tool": "Bash", "argsSummary": strings.Repeat("é", 400)}), "Galahad")
	got, ok := reg.get("t1")
	if !ok {
		t.Fatal("tool event for an unknown task should create the entry")
	}
	if n := len([]rune(got.LastTool.ArgsSummary)); n != maxActivityArgs {
		t.Fatalf("argsSummary has %d runes, want %d", n, maxActivityArgs)
	}
	if got.CurrentTool != "Bash" {
		t.Fatalf("currentTool = %q", got.CurrentTool)
	}
}

func TestRunningReorderedStartKeepsLaterState(t *testing.T) {
	reg, _ := newTestRegistry(10)
	reg.handleActivity(activity(t, "task.heartbeat", "t1", 2, map[string]any{"turns": 4}), "Galahad")
	reg.handleActivity(activity(t, "task.started", "t1", 1, map[string]any{"slot": 1}), "Galahad")
	got, _ := reg.get("t1")
	if got.Turns == nil || *got.Turns != 4 || got.Slot == nil || *got.Slot != 1 || got.Seq != 2 {
		t.Fatalf("reordered start lost state: %+v", got)
	}
}

func TestRunningRejectsInvalidEvents(t *testing.T) {
	reg, _ := newTestRegistry(10)
	reg.handleActivity([]byte("not json"), "Galahad")
	reg.handleActivity(activity(t, "task.started", "t-v2", 1, map[string]any{"v": 2}), "Galahad")
	reg.handleActivity(activity(t, "task.started", "", 1, nil), "Galahad")
	reg.handleActivity(activity(t, "task.bogus", "t-bogus", 1, nil), "Galahad")
	reg.handleActivity(activity(t, "task.started", "t-big", 1, map[string]any{"pad": strings.Repeat("a", maxActivityEventBytes)}), "Galahad")
	if n := len(reg.snapshot()); n != 0 {
		t.Fatalf("invalid events created %d entries: %+v", n, reg.snapshot())
	}

	// Knight falls back to the subject token.
	reg.handleActivity(activity(t, "task.started", "t-ok", 1, map[string]any{"knight": ""}), "Tristan")
	if got, _ := reg.get("t-ok"); got.Knight != "Tristan" {
		t.Fatalf("knight = %q, want subject knight", got.Knight)
	}
}

func TestRunningHeartbeatTimeoutGoesStale(t *testing.T) {
	reg, clk := newTestRegistry(10)
	reg.handleActivity(activity(t, "task.started", "t1", 1, nil), "Galahad")

	clk.add(29 * time.Second)
	reg.sweep()
	if got, _ := reg.get("t1"); got.Status != runningStatusRunning {
		t.Fatalf("status after 29s = %s, want running", got.Status)
	}

	clk.add(2 * time.Second) // 31s > 3 x 10s
	reg.sweep()
	if got, _ := reg.get("t1"); got.Status != runningStatusStale {
		t.Fatalf("status after 31s = %s, want stale", got.Status)
	}

	// A heartbeat brings it back.
	reg.handleActivity(activity(t, "task.heartbeat", "t1", 2, nil), "Galahad")
	if got, _ := reg.get("t1"); got.Status != runningStatusRunning {
		t.Fatalf("status after heartbeat = %s, want running", got.Status)
	}

	// Stale long enough expires the entry.
	clk.add(31 * time.Second)
	reg.sweep()
	clk.add(defaultStaleRetention)
	reg.sweep()
	if _, ok := reg.get("t1"); ok {
		t.Fatal("stale entry was not expired after the retention")
	}
}

func TestRunningPodGoneGoesLost(t *testing.T) {
	setupTestRouter()
	ns := "test-namespace"
	mkPod := func(name string) *corev1.Pod {
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: map[string]string{
				"app.kubernetes.io/name": "knight", "app.kubernetes.io/instance": "galahad",
			}},
			Status: corev1.PodStatus{Phase: corev1.PodRunning},
		}
	}
	ctx := context.Background()
	for _, p := range []*corev1.Pod{mkPod("galahad-abc-1"), mkPod("galahad-abc-2")} {
		if _, err := fakeK8sClient.CoreV1().Pods(ns).Create(ctx, p, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}

	reg, clk := newTestRegistry(10)
	reg.handleActivity(activity(t, "task.started", "t1", 1, nil), "Galahad")
	reg.handleActivity(activity(t, "task.started", "t2", 1, map[string]any{"pod": "galahad-abc-2"}), "Galahad")

	_, live, err := listKnightPods(ctx, ns, nil, "")
	if err != nil {
		t.Fatal(err)
	}
	reg.reconcilePods(live)
	if got, _ := reg.get("t1"); got.Status != runningStatusRunning {
		t.Fatalf("t1 = %s while its pod exists", got.Status)
	}

	if err := fakeK8sClient.CoreV1().Pods(ns).Delete(ctx, "galahad-abc-1", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	_, live, _ = listKnightPods(ctx, ns, nil, "")
	reg.reconcilePods(live)

	got, _ := reg.get("t1")
	if got.Status != runningStatusLost || got.LostReason != lostReasonPodGone {
		t.Fatalf("t1 = %s/%s, want lost/pod_gone", got.Status, got.LostReason)
	}
	if got, _ := reg.get("t2"); got.Status != runningStatusRunning {
		t.Fatalf("t2 = %s, want running (its pod is alive)", got.Status)
	}

	// Lost is not turned back into stale/running by the sweeper or heartbeats...
	clk.add(time.Minute)
	reg.sweep()
	reg.handleActivity(activity(t, "task.heartbeat", "t1", 2, nil), "Galahad")
	if got, _ := reg.get("t1"); got.Status != runningStatusLost {
		t.Fatalf("t1 = %s, want lost to stick", got.Status)
	}
	// ...but a redelivery that starts the task again on another pod is running.
	reg.handleActivity(activity(t, "task.started", "t1", 1, map[string]any{"pod": "galahad-abc-2"}), "Galahad")
	if got, _ := reg.get("t1"); got.Status != runningStatusRunning || got.Pod != "galahad-abc-2" {
		t.Fatalf("redelivered t1 = %+v", got)
	}

	// Lost entries are dropped after the retention.
	reg.markLost("t2", lostReasonPodGone)
	clk.add(defaultLostRetention + time.Second)
	reg.sweep()
	if _, ok := reg.get("t2"); ok {
		t.Fatal("lost entry was not dropped after the retention")
	}
}

func TestRunningMaxDeliveriesGoesLost(t *testing.T) {
	reg, _ := newTestRegistry(10)
	reg.handleActivity(activity(t, "task.started", "galahad-ws-42", 1, nil), "Galahad")

	fetch := func(stream string, seq uint64) (string, []byte, error) {
		if stream != "fleet_a_tasks" || seq != 7 {
			return "", nil, errors.New("no such message")
		}
		return "fleet-a.tasks.security.galahad-ws-42", []byte(`{"task":"x"}`), nil
	}
	reg.handleMaxDeliveries([]byte(`{"type":"io.nats.jetstream.advisory.v1.max_deliver","stream":"fleet_a_tasks","consumer":"galahad","stream_seq":8,"deliveries":5}`), fetch)
	if got, _ := reg.get("galahad-ws-42"); got.Status != runningStatusRunning {
		t.Fatalf("unrelated advisory changed status to %s", got.Status)
	}
	reg.handleMaxDeliveries([]byte(`{"type":"io.nats.jetstream.advisory.v1.max_deliver","stream":"fleet_a_tasks","consumer":"galahad","stream_seq":7,"deliveries":5}`), fetch)
	got, _ := reg.get("galahad-ws-42")
	if got.Status != runningStatusLost || got.LostReason != lostReasonMaxDeliveries {
		t.Fatalf("status = %s/%s, want lost/max_deliveries", got.Status, got.LostReason)
	}
}

func TestTaskIDFromTaskMessage(t *testing.T) {
	cases := []struct {
		subject, data, want string
	}{
		{"fleet-a.tasks.security.abc", `{"task_id":"from-payload"}`, "from-payload"},
		{"fleet-a.tasks.security.abc", `{"taskId":"camel"}`, "camel"},
		{"fleet-a.tasks.security.abc", `{}`, "abc"},
		{"fleet-a.tasks.security.abc", `not json`, "abc"},
		{"fleet-a.results.abc", `{}`, ""},
	}
	for _, c := range cases {
		if got := taskIDFromTaskMessage(c.subject, []byte(c.data)); got != c.want {
			t.Errorf("taskIDFromTaskMessage(%q, %q) = %q, want %q", c.subject, c.data, got, c.want)
		}
	}
}

func TestRunningRegistryIsBounded(t *testing.T) {
	reg, clk := newTestRegistry(3)
	for i := 1; i <= 3; i++ {
		clk.add(time.Second)
		reg.handleActivity(activity(t, "task.started", fmt.Sprintf("t%d", i), 1, map[string]any{
			"ts": clk.now().Format(time.RFC3339Nano),
		}), "Galahad")
	}
	reg.markLost("t2", lostReasonPodGone)

	rec := &recorder{}
	defer reg.subscribe(rec.fn)()
	clk.add(time.Second)
	reg.handleActivity(activity(t, "task.started", "t4", 1, map[string]any{"ts": clk.now().Format(time.RFC3339Nano)}), "Galahad")
	if _, ok := reg.get("t2"); ok {
		t.Fatal("the lost entry should be evicted first")
	}
	clk.add(time.Second)
	reg.handleActivity(activity(t, "task.started", "t5", 1, map[string]any{"ts": clk.now().Format(time.RFC3339Nano)}), "Galahad")
	if _, ok := reg.get("t1"); ok {
		t.Fatal("then the oldest entry should be evicted")
	}
	if n := len(reg.snapshot()); n != 3 {
		t.Fatalf("registry holds %d entries, want 3", n)
	}
	want := []string{"snapshot", "remove:evicted", "upsert:running", "remove:evicted", "upsert:running"}
	if fmt.Sprint(rec.ops()) != fmt.Sprint(want) {
		t.Fatalf("deltas = %v, want %v", rec.ops(), want)
	}
}

// makeKnightCRWithSubjects builds a Knight CR whose NATS prefix is prefix.
func makeKnightCRWithSubjects(name, namespace, prefix string) *unstructured.Unstructured {
	cr := makeTestKnightCR(name, namespace, "security")
	_ = unstructured.SetNestedStringSlice(cr.Object, []string{prefix + ".tasks.security.>"}, "spec", "nats", "subjects")
	return cr
}

func TestRunningAPIRestartRebuildsRegistry(t *testing.T) {
	setupTestRouter()
	ns := "test-namespace"
	ctx := context.Background()
	for _, cr := range []*unstructured.Unstructured{
		makeKnightCRWithSubjects("galahad", ns, "fleet-a"),
		makeKnightCRWithSubjects("tortoise", ns, "chelonian"),
	} {
		if _, err := dynClient.Resource(knightGVR).Namespace(ns).Create(ctx, cr, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	pod := func(name, knight string, phase corev1.PodPhase) *corev1.Pod {
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns, Labels: map[string]string{
				"app.kubernetes.io/name": "knight", "app.kubernetes.io/instance": knight,
			}},
			Spec:   corev1.PodSpec{NodeName: "node-" + name},
			Status: corev1.PodStatus{Phase: phase},
		}
	}
	for _, p := range []*corev1.Pod{
		pod("galahad-abc-1", "galahad", corev1.PodRunning),
		pod("galahad-abc-2", "galahad", corev1.PodRunning),
		pod("galahad-abc-3", "galahad", corev1.PodPending),
		pod("tortoise-xyz-1", "tortoise", corev1.PodRunning),
	} {
		if _, err := fakeK8sClient.CoreV1().Pods(ns).Create(ctx, p, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}

	// Before the restart: a registry fed by live events.
	before, _ := newTestRegistry(10)
	before.handleActivity(activity(t, "task.started", "t1", 1, map[string]any{"pod": "galahad-abc-1"}), "Galahad")
	before.handleActivity(activity(t, "task.started", "t2", 1, map[string]any{"pod": "galahad-abc-2"}), "Galahad")

	var mu sync.Mutex
	var asked []string
	req := func(subject string, data []byte, _ time.Duration) ([]byte, error) {
		mu.Lock()
		asked = append(asked, subject)
		mu.Unlock()
		if string(data) != `{"type":"stats"}` {
			return nil, fmt.Errorf("unexpected request %s", data)
		}
		switch subject {
		case "fleet-a.introspect.Galahad.galahad-abc-1":
			return []byte(`{"pod":"galahad-abc-1","node":"node-a","inflight":[{"taskId":"t1","runId":"run-1","chainName":"pr-pipeline","stepName":"implement","model":"claude-opus-5-5","startedAt":"2026-11-24T11:59:00.000Z","lastHeartbeatAt":"2026-11-24T11:59:50.000Z"}]}`), nil
		case "fleet-a.introspect.Galahad.galahad-abc-2":
			return []byte(`{"pod":"galahad-abc-2","node":"node-b","inflight":[{"taskId":"t2","startedAt":"2026-11-24T11:59:30.000Z","lastHeartbeatAt":null},{"taskId":"t-live"}]}`), nil
		}
		return nil, errors.New("timeout")
	}

	// After the restart: an empty registry, one event seen live already.
	after, _ := newTestRegistry(10)
	after.handleActivity(activity(t, "task.started", "t-live", 7, map[string]any{"pod": "galahad-abc-2", "model": "live-model"}), "Galahad")
	n := bootstrapRunning(ctx, after, ns, []string{"fleet-a"}, "fleet-a", req, time.Second)
	if n != 2 {
		t.Fatalf("bootstrap added %d tasks, want 2 (t-live was already known)", n)
	}

	for _, id := range []string{"t1", "t2"} {
		b, _ := before.get(id)
		a, ok := after.get(id)
		if !ok {
			t.Fatalf("%s not rebuilt", id)
		}
		if a.TaskID != b.TaskID || a.Knight != b.Knight || a.Pod != b.Pod || a.Status != runningStatusRunning || a.Source != "introspect" {
			t.Fatalf("%s rebuilt as %+v, before restart %+v", id, a, b)
		}
	}
	t1, _ := after.get("t1")
	if t1.RunID != "run-1" || t1.ChainName != "pr-pipeline" || t1.Node != "node-a" ||
		!t1.StartedAt.Equal(time.Date(2026, 11, 24, 11, 59, 0, 0, time.UTC)) || t1.LastHeartbeatAt == nil {
		t.Fatalf("t1 rebuilt without introspect details: %+v", t1)
	}
	if live, _ := after.get("t-live"); live.Model != "live-model" || live.Source != "activity" {
		t.Fatalf("bootstrap overwrote a live entry: %+v", live)
	}

	// Only running pods on a subscribed prefix were asked.
	for _, s := range asked {
		if strings.Contains(s, "galahad-abc-3") || strings.HasPrefix(s, "chelonian.") {
			t.Fatalf("asked %s (pending pod or unsubscribed table)", s)
		}
	}
	if len(asked) != 2 {
		t.Fatalf("asked %v, want the two running galahad pods", asked)
	}

	// A heartbeat confirms an introspected entry.
	after.handleActivity(activity(t, "task.heartbeat", "t1", 9, nil), "Galahad")
	if got, _ := after.get("t1"); got.Source != "activity" {
		t.Fatalf("source after heartbeat = %s", got.Source)
	}
}

func TestValidPodName(t *testing.T) {
	for _, ok := range []string{"galahad-7d9f-abcde", "a1"} {
		if !validPodName(ok) {
			t.Errorf("validPodName(%q) = false", ok)
		}
	}
	for _, bad := range []string{"", "a.b", "a*", "a>", "Upper", "a b"} {
		if validPodName(bad) {
			t.Errorf("validPodName(%q) = true", bad)
		}
	}
}

func TestRunningHandler(t *testing.T) {
	reg, _ := newTestRegistry(10)
	reg.handleActivity(activity(t, "task.started", "t2", 1, map[string]any{"ts": "2026-11-24T12:00:05.000Z"}), "Galahad")
	reg.handleActivity(activity(t, "task.started", "t1", 1, nil), "Galahad")
	reg.handleActivity(activity(t, "tool.finished", "t1", 2, map[string]any{"tool": "Bash", "outputPreview": "token=ghp_abcdefghijklmnopqrstuvwxyz0123"}), "Galahad")

	w := httptest.NewRecorder()
	runningHandler(reg, "roundtable")(w, httptest.NewRequest(http.MethodGet, "/api/running", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "ghp_abcdefghijklmnopqrstuvwxyz0123") {
		t.Fatal("secret in output preview was not redacted")
	}
	var resp runningResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Count != 2 || len(resp.Tasks) != 2 || resp.Tasks[0].TaskID != "t1" || resp.Tasks[1].TaskID != "t2" {
		t.Fatalf("unexpected response (want t1, t2 oldest first): %+v", resp)
	}
	if resp.HeartbeatIntervalMs != 10000 || resp.StaleAfterMs != 30000 {
		t.Fatalf("intervals = %d/%d", resp.HeartbeatIntervalMs, resp.StaleAfterMs)
	}
}

func TestRunningWSEvent(t *testing.T) {
	reg, _ := newTestRegistry(10)
	var frames [][]byte
	unsub := reg.subscribe(func(d RunningDelta) { frames = append(frames, runningWSEvent(d)) })
	reg.handleActivity(activity(t, "task.started", "t1", 1, nil), "Galahad")
	reg.handleActivity(activity(t, "task.finished", "t1", 2, nil), "Galahad")
	unsub()
	reg.handleActivity(activity(t, "task.started", "t3", 1, nil), "Galahad")

	if len(frames) != 3 {
		t.Fatalf("got %d frames, want snapshot, upsert, remove (none after unsubscribe)", len(frames))
	}
	var ev struct {
		Type    string       `json:"type"`
		Subject string       `json:"subject"`
		Data    RunningDelta `json:"data"`
	}
	if err := json.Unmarshal(frames[1], &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Type != "running" || ev.Data.Op != "upsert" || ev.Data.Task == nil || ev.Data.Task.TaskID != "t1" {
		t.Fatalf("unexpected upsert frame: %s", frames[1])
	}
	if err := json.Unmarshal(frames[2], &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Data.Op != "remove" || ev.Data.TaskID != "t1" || ev.Data.Reason != "finished" {
		t.Fatalf("unexpected remove frame: %s", frames[2])
	}
}

func TestRunningHeartbeatIntervalEnv(t *testing.T) {
	t.Setenv("ACTIVITY_HEARTBEAT_INTERVAL", "5s")
	if d := runningHeartbeatInterval(); d != 5*time.Second {
		t.Fatalf("interval = %s", d)
	}
	t.Setenv("ACTIVITY_HEARTBEAT_INTERVAL", "garbage")
	if d := runningHeartbeatInterval(); d != defaultHeartbeatInterval {
		t.Fatalf("interval = %s", d)
	}
	t.Setenv("ACTIVITY_PREFIXES", " fleet-a , chelonian,")
	if p := activityPrefixes([]string{"x"}); fmt.Sprint(p) != "[fleet-a chelonian]" {
		t.Fatalf("prefixes = %v", p)
	}
	// Without the override every table's prefix is tracked (#239).
	t.Setenv("ACTIVITY_PREFIXES", "")
	if p := activityPrefixes([]string{"fleet-a", "rt-dev"}); fmt.Sprint(p) != "[fleet-a rt-dev]" {
		t.Fatalf("prefixes = %v", p)
	}
}

// TestRunningTaskWireNames pins the JSON contract consumed by the Running page.
func TestRunningTaskWireNames(t *testing.T) {
	hb := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	b, err := json.Marshal(RunningTask{
		TaskID: "t1", Status: runningStatusLost, LostReason: lostReasonPodGone,
		LastHeartbeatAt: &hb, LastTool: &RunningToolEvent{Tool: "Bash", At: hb},
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"reason", "lastHeartbeat"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing key %q in %s", k, b)
		}
	}
	for _, k := range []string{"lostReason", "lastHeartbeatAt"} {
		if _, ok := m[k]; ok {
			t.Errorf("unexpected key %q in %s", k, b)
		}
	}
	tool := m["lastTool"].(map[string]any)
	if _, ok := tool["ts"]; !ok {
		t.Errorf("lastTool missing ts: %s", b)
	}
	if _, ok := tool["at"]; ok {
		t.Errorf("lastTool has legacy at: %s", b)
	}
}

func TestWithTables(t *testing.T) {
	tables := map[string]string{"galahad": "alpha"}
	d := RunningDelta{Op: "upsert", Task: &RunningTask{TaskID: "t1", Knight: "Galahad"}}
	got := withTables(d, tables)
	if got.Task.Table != "alpha" {
		t.Fatalf("table = %q, want alpha", got.Task.Table)
	}
	if d.Task.Table != "" {
		t.Fatal("input delta was mutated")
	}
	snap := withTables(RunningDelta{Op: "snapshot", Tasks: []RunningTask{{TaskID: "t2", Knight: "Nobody"}}}, tables)
	if snap.Tasks[0].Table != "none" {
		t.Fatalf("unknown knight table = %q, want none", snap.Tasks[0].Table)
	}
	if rm := withTables(RunningDelta{Op: "remove", TaskID: "t1"}, tables); rm.Task != nil {
		t.Fatal("remove delta gained a task")
	}
}

func TestActivityFollowerFollowsPrefixes(t *testing.T) {
	conn, _ := startCardsNATS(t)
	reg, _ := newTestRegistry(10)
	f := newActivityFollower(conn, reg, nil)

	publish := func(prefix, task string) {
		ev, _ := json.Marshal(activityEvent{V: 1, Type: "task.started", Knight: "k", TaskID: task})
		if err := conn.Publish(prefix+".activity.k."+task, ev); err != nil {
			t.Fatal(err)
		}
		if err := conn.Flush(); err != nil {
			t.Fatal(err)
		}
	}
	waitLen := func(n int) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if len(reg.snapshot()) == n {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("registry has %d entries, want %d", len(reg.snapshot()), n)
	}

	if added := f.sync([]string{"a"}); len(added) != 1 {
		t.Fatalf("added = %v", added)
	}
	publish("b", "t0") // not yet followed
	publish("a", "t1")
	waitLen(1)

	// A table created after start is picked up; a repeat sync adds nothing.
	if added := f.sync([]string{"a", "b"}); len(added) != 1 || added[0] != "b" {
		t.Fatalf("added = %v", added)
	}
	if added := f.sync([]string{"a", "b"}); len(added) != 0 {
		t.Fatalf("second sync added %v", added)
	}
	publish("b", "t2") // one event adds exactly one entry
	waitLen(2)

	// A removed table stops delivering.
	f.sync([]string{"a"})
	publish("b", "t3")
	publish("a", "t4")
	waitLen(3)
	if _, ok := reg.get("t3"); ok {
		t.Fatal("event of removed table was delivered")
	}
}
