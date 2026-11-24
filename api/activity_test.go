package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func newTestActivityStore() (*activityStore, *fakeClock) {
	clk := &fakeClock{t: time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)}
	s := newActivityStore()
	s.now = clk.now
	return s, clk
}

// activityRecorder collects activity messages a subscription sends.
type activityRecorder struct {
	mu       sync.Mutex
	msgs     []ActivityMsg
	critical []bool
}

func (r *activityRecorder) send(critical bool, data []byte) {
	var ev struct {
		Type string      `json:"type"`
		Data ActivityMsg `json:"data"`
	}
	if err := json.Unmarshal(data, &ev); err != nil || ev.Type != "activity" {
		panic(fmt.Sprintf("bad ws event %q: %v", data, err))
	}
	r.mu.Lock()
	r.msgs = append(r.msgs, ev.Data)
	r.critical = append(r.critical, critical)
	r.mu.Unlock()
}

func (r *activityRecorder) all() []ActivityMsg {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]ActivityMsg(nil), r.msgs...)
}

func subCmd(op, taskID string) []byte {
	b, _ := json.Marshal(map[string]string{op: "activity", "taskId": taskID})
	return b
}

func TestActivityMidRunSubscribeGetsBacklogThenLive(t *testing.T) {
	s, _ := newTestActivityStore()
	s.handleActivity(activity(t, "task.started", "t1", 1, map[string]any{"model": "opus"}), "Galahad")
	s.handleActivity(activity(t, "tool.started", "t1", 2, map[string]any{"tool": "bash", "argsSummary": "ls"}), "Galahad")
	s.handleActivity(activity(t, "task.heartbeat", "t1", 3, map[string]any{"turns": 2, "costUsd": 0.12}), "Galahad")
	s.handleActivity(activity(t, "tool.finished", "t1", 4, map[string]any{"tool": "bash", "durationMs": 40, "isError": false}), "Galahad")

	rec := &activityRecorder{}
	a := newActivitySubscriptions(s, rec.send)
	if !a.handle(subCmd("subscribe", "t1")) {
		t.Fatal("subscribe not handled")
	}
	s.handleActivity(activity(t, "assistant.message", "t1", 5, map[string]any{"preview": "done"}), "Galahad")

	msgs := rec.all()
	if len(msgs) != 2 {
		t.Fatalf("want backlog + 1 live, got %d: %+v", len(msgs), msgs)
	}
	bl := msgs[0]
	if bl.Op != "backlog" || bl.TaskID != "t1" || !rec.critical[0] {
		t.Fatalf("first message must be a critical backlog: %+v", bl)
	}
	// Heartbeats update the header but are not timeline items.
	if len(bl.Events) != 3 || bl.Events[0].Type != "task.started" || bl.Events[2].Type != "tool.finished" {
		t.Fatalf("backlog events: %+v", bl.Events)
	}
	if bl.Task == nil || bl.Task.Model != "claude-opus-5-5" || bl.Task.Knight != "Galahad" || bl.Task.Seq != 4 ||
		bl.Task.Turns == nil || *bl.Task.Turns != 2 || bl.Task.CostUSD == nil || *bl.Task.CostUSD != 0.12 {
		t.Fatalf("backlog header: %+v", bl.Task)
	}
	live := msgs[1]
	if live.Op != "event" || live.Event == nil || live.Event.Type != "assistant.message" || live.Event.Preview != "done" || live.Event.Seq != 5 {
		t.Fatalf("live event: %+v", live)
	}
	if rec.critical[1] {
		t.Fatal("live events must be droppable")
	}
}

func TestActivityOnlySubscribedTasksDelivered(t *testing.T) {
	s, _ := newTestActivityStore()
	r1, r2 := &activityRecorder{}, &activityRecorder{}
	a1 := newActivitySubscriptions(s, r1.send)
	a2 := newActivitySubscriptions(s, r2.send)
	a1.handle(subCmd("subscribe", "task-a"))
	a2.handle(subCmd("subscribe", "task-b"))

	s.handleActivity(activity(t, "task.started", "task-a", 1, nil), "K")
	s.handleActivity(activity(t, "task.started", "task-b", 1, nil), "K")
	s.handleActivity(activity(t, "task.started", "task-c", 1, nil), "K")

	for name, tc := range map[string]struct {
		r    *activityRecorder
		want string
	}{"a1": {r1, "task-a"}, "a2": {r2, "task-b"}} {
		msgs := tc.r.all()
		if len(msgs) != 2 {
			t.Fatalf("%s: want backlog + 1 event, got %+v", name, msgs)
		}
		for _, m := range msgs {
			if m.TaskID != tc.want {
				t.Fatalf("%s received another task's message: %+v", name, m)
			}
		}
	}

	// Unsubscribe stops delivery.
	a1.handle(subCmd("unsubscribe", "task-a"))
	s.handleActivity(activity(t, "assistant.message", "task-a", 2, nil), "K")
	if n := len(r1.all()); n != 2 {
		t.Fatalf("event after unsubscribe delivered (%d msgs)", n)
	}
}

// blockingConn never completes a write until released.
type blockingConn struct{ release chan struct{} }

func (b *blockingConn) SetWriteDeadline(time.Time) error { return nil }
func (b *blockingConn) WriteMessage(int, []byte) error {
	<-b.release
	return nil
}

func TestActivitySlowClientDoesNotBlockIngest(t *testing.T) {
	s, _ := newTestActivityStore()
	conn := &blockingConn{release: make(chan struct{})}
	defer close(conn.release)
	w := newWSWriter(conn, 8, nil)
	go w.run()
	defer w.close()

	a := newActivitySubscriptions(s, func(critical bool, data []byte) { w.enqueue(data, critical) })
	a.handle(subCmd("subscribe", "slow"))

	fast := &activityRecorder{}
	b := newActivitySubscriptions(s, fast.send)
	b.handle(subCmd("subscribe", "slow"))

	done := make(chan struct{})
	go func() {
		s.handleActivity(activity(t, "task.started", "slow", 1, nil), "K")
		for i := int64(2); i <= 1000; i++ {
			s.handleActivity(activity(t, "tool.started", "slow", i, map[string]any{"tool": "bash"}), "K")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ingest blocked on a slow client")
	}
	if n := len(fast.all()); n != 1001 {
		t.Fatalf("other watcher got %d messages, want 1001", n)
	}
	if w.drops.Load() == 0 {
		t.Fatal("slow client should have dropped live events")
	}
	if w.isClosed() {
		t.Fatal("dropping droppable events must not close the client")
	}
}

func TestActivityRingBufferAndGaps(t *testing.T) {
	s, _ := newTestActivityStore()
	s.handleActivity(activity(t, "task.started", "r", 1, nil), "K")
	s.handleActivity(activity(t, "tool.started", "r", 5, nil), "K") // 2-4 lost
	for i := int64(6); i < 6+activityRingSize; i++ {
		s.handleActivity(activity(t, "assistant.message", "r", i, nil), "K")
	}
	rec := &activityRecorder{}
	s.watch("r", func(m ActivityMsg) {
		b, _ := json.Marshal(TaskEvent{Type: "activity", Data: mustJSON(m)})
		rec.send(true, b)
	})
	bl := rec.all()[0]
	if len(bl.Events) != activityRingSize || bl.Dropped != 2 {
		t.Fatalf("ring: %d events, dropped %d", len(bl.Events), bl.Dropped)
	}
	if bl.Events[0].Seq != 6 || bl.Events[len(bl.Events)-1].Seq != 5+activityRingSize {
		t.Fatalf("ring should keep the newest events: first %d last %d", bl.Events[0].Seq, bl.Events[len(bl.Events)-1].Seq)
	}

	s2, _ := newTestActivityStore()
	s2.handleActivity(activity(t, "task.started", "g", 1, nil), "K")
	s2.handleActivity(activity(t, "tool.started", "g", 5, nil), "K")
	s2.handleActivity(activity(t, "task.heartbeat", "g", 6, nil), "K")
	s2.handleActivity(activity(t, "tool.finished", "g", 7, nil), "K")
	var got ActivityMsg
	s2.watch("g", func(m ActivityMsg) { got = m })
	if len(got.Events) != 3 || got.Events[1].Gap != 3 || got.Events[2].Gap != 0 {
		t.Fatalf("gaps: %+v", got.Events)
	}
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func TestActivitySanitizesEvents(t *testing.T) {
	s, _ := newTestActivityStore()
	long := strings.Repeat("x", 600)
	s.handleActivity(activity(t, "tool.finished", "s", 1, map[string]any{
		"tool":          "bash",
		"argsSummary":   "curl -H 'Authorization: Bearer abcdefghijklmnop'",
		"outputPreview": long,
		"env":           map[string]string{"SECRET": "nope"},
	}), "K")
	s.handleActivity(activity(t, "assistant.message", "s", 2, map[string]any{"preview": "key ghp_" + strings.Repeat("a", 36)}), "K")

	var got ActivityMsg
	s.watch("s", func(m ActivityMsg) { got = m })
	if len(got.Events) != 2 {
		t.Fatalf("events: %+v", got.Events)
	}
	tool := got.Events[0]
	if strings.Contains(tool.ArgsSummary, "abcdefghijklmnop") || !strings.Contains(tool.ArgsSummary, redactedMarker) {
		t.Fatalf("args not redacted: %q", tool.ArgsSummary)
	}
	if len([]rune(tool.OutputPreview)) != maxActivityPreview || !tool.Truncated {
		t.Fatalf("preview not bounded: %d truncated=%v", len(tool.OutputPreview), tool.Truncated)
	}
	if strings.Contains(string(mustJSON(got)), "nope") {
		t.Fatal("unknown fields must not be relayed")
	}
	if strings.Contains(got.Events[1].Preview, "ghp_") {
		t.Fatalf("token not redacted: %q", got.Events[1].Preview)
	}

	// Oversized and malformed events are dropped.
	s.handleActivity(activity(t, "assistant.message", "big", 1, map[string]any{"preview": strings.Repeat("y", maxActivityEventBytes)}), "K")
	s.handleActivity([]byte("{not json"), "K")
	s.handleActivity(activity(t, "bogus.type", "s", 3, nil), "K")
	if s.taskCount() != 1 {
		t.Fatalf("invalid events created tasks: %d", s.taskCount())
	}
}

func TestActivityWatchLimitAndValidation(t *testing.T) {
	s, _ := newTestActivityStore()
	rec := &activityRecorder{}
	a := newActivitySubscriptions(s, rec.send)
	a.limiter = nil
	for i := 0; i < activityMaxWatchedPerClient; i++ {
		a.handle(subCmd("subscribe", fmt.Sprintf("t%d", i)))
	}
	a.handle(subCmd("subscribe", "t0")) // duplicate: no-op
	if a.count() != activityMaxWatchedPerClient {
		t.Fatalf("watched %d", a.count())
	}
	a.handle(subCmd("subscribe", "one-too-many"))
	msgs := rec.all()
	last := msgs[len(msgs)-1]
	if a.count() != activityMaxWatchedPerClient || last.Op != "error" || last.Error != activityErrWatchLimit || last.TaskID != "one-too-many" {
		t.Fatalf("limit not enforced: count=%d last=%+v", a.count(), last)
	}
	a.handle(subCmd("subscribe", "bad id"))
	if last := rec.all()[len(rec.all())-1]; last.Error != activityErrInvalidTaskID || last.TaskID != "" {
		t.Fatalf("invalid id: %+v", last)
	}

	a.closeAll()
	if a.count() != 0 {
		t.Fatal("closeAll left subscriptions")
	}
	s.mu.Lock()
	n := len(s.watchers)
	s.mu.Unlock()
	if n != 0 {
		t.Fatalf("store still has %d watched tasks", n)
	}

	if a.handle([]byte(`{"action":"dispatch","knight":"k"}`)) {
		t.Fatal("dispatch commands are not activity commands")
	}
}

func TestActivitySubscribeRateLimited(t *testing.T) {
	s, _ := newTestActivityStore()
	rec := &activityRecorder{}
	a := newActivitySubscriptions(s, rec.send)
	a.limit = 1000
	clk := &fakeClock{t: time.Now()}
	a.limiter = newTokenBucket(1, 2, clk.now)
	for i := 0; i < 3; i++ {
		a.handle(subCmd("subscribe", fmt.Sprintf("t%d", i)))
	}
	if a.count() != 2 {
		t.Fatalf("watched %d, want 2", a.count())
	}
	if last := rec.all()[len(rec.all())-1]; last.Error != activityErrRateLimited {
		t.Fatalf("want rate_limited, got %+v", last)
	}
}

func TestActivityRetention(t *testing.T) {
	s, clk := newTestActivityStore()
	s.handleActivity(activity(t, "task.started", "done", 1, nil), "K")
	s.handleActivity(activity(t, "task.finished", "done", 2, map[string]any{"success": true, "durationMs": 1200}), "K")
	s.handleActivity(activity(t, "task.started", "watched", 1, nil), "K")
	s.handleActivity(activity(t, "task.finished", "watched", 2, nil), "K")
	s.handleActivity(activity(t, "task.started", "running", 1, nil), "K")

	var hdr *ActivityTaskInfo
	unwatch := s.watch("watched", func(m ActivityMsg) { hdr = m.Task })
	if hdr == nil || !hdr.Finished {
		t.Fatalf("finished header: %+v", hdr)
	}

	clk.add(14 * time.Minute)
	s.sweep()
	if s.taskCount() != 3 {
		t.Fatal("finished tasks must be kept for 15 minutes")
	}
	clk.add(2 * time.Minute)
	s.sweep()
	if s.taskCount() != 2 {
		t.Fatalf("finished unwatched task should be gone, have %d", s.taskCount())
	}
	unwatch()
	s.sweep()
	if s.taskCount() != 1 {
		t.Fatalf("unwatched finished task should be gone, have %d", s.taskCount())
	}
	clk.add(time.Hour)
	s.sweep()
	if s.taskCount() != 0 {
		t.Fatal("idle running task should expire")
	}
}

func TestActivityEvictsFinishedFirst(t *testing.T) {
	s, clk := newTestActivityStore()
	s.maxTasks = 2
	s.handleActivity(activity(t, "task.started", "old-running", 1, nil), "K")
	clk.add(time.Second)
	s.handleActivity(activity(t, "task.finished", "finished", 1, nil), "K")
	clk.add(time.Second)
	s.handleActivity(activity(t, "task.started", "new", 1, nil), "K")
	s.mu.Lock()
	_, kept := s.tasks["old-running"]
	_, gone := s.tasks["finished"]
	s.mu.Unlock()
	if !kept || gone || s.taskCount() != 2 {
		t.Fatal("eviction should prefer finished tasks")
	}
}

func TestActivityRedeliveryRestartsSeq(t *testing.T) {
	s, _ := newTestActivityStore()
	s.handleActivity(activity(t, "task.started", "rd", 1, nil), "K")
	s.handleActivity(activity(t, "tool.started", "rd", 9, nil), "K")
	s.handleActivity(activity(t, "task.started", "rd", 1, nil), "K")
	s.handleActivity(activity(t, "tool.started", "rd", 2, nil), "K")
	var got ActivityMsg
	s.watch("rd", func(m ActivityMsg) { got = m })
	if got.Task.Seq != 2 || got.Events[3].Gap != 0 || got.Task.Finished {
		t.Fatalf("redelivery: %+v %+v", got.Task, got.Events)
	}
}
