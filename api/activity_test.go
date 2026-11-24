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

// addRaw parses and adds a raw event like the NATS callback does.
func addRaw(t *testing.T, s *activityStore, raw []byte) {
	t.Helper()
	ev, ok := parseActivityEvent(raw, "Galahad")
	if !ok {
		t.Fatalf("invalid test event %s", raw)
	}
	s.add(ev, raw)
}

// wsSink records what an activityClient sends, decoded.
type wsSink struct {
	mu   sync.Mutex
	msgs []ActivityMessage
	crit []bool
	fail func(m ActivityMessage) bool // return true to reject the send
}

func (k *wsSink) send(data []byte, critical bool) bool {
	var ev TaskEvent
	if err := json.Unmarshal(data, &ev); err != nil || ev.Type != "activity" {
		panic(fmt.Sprintf("bad ws event %s", data))
	}
	var m ActivityMessage
	if err := json.Unmarshal(ev.Data, &m); err != nil {
		panic(err)
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.fail != nil && k.fail(m) {
		return false
	}
	k.msgs = append(k.msgs, m)
	k.crit = append(k.crit, critical)
	return true
}

func (k *wsSink) all() []ActivityMessage {
	k.mu.Lock()
	defer k.mu.Unlock()
	return append([]ActivityMessage(nil), k.msgs...)
}

func seqOf(t *testing.T, raw json.RawMessage) int64 {
	t.Helper()
	var ev activityEvent
	if err := json.Unmarshal(raw, &ev); err != nil {
		t.Fatal(err)
	}
	return ev.Seq
}

func cmd(op, taskID string) []byte {
	b, _ := json.Marshal(map[string]string{op: "activity", "taskId": taskID})
	return b
}

func TestActivitySubscribeMidRunGetsBacklogThenLive(t *testing.T) {
	s, _ := newTestActivityStore()
	addRaw(t, s, activity(t, "task.started", "t1", 1, nil))
	addRaw(t, s, activity(t, "tool.started", "t1", 2, map[string]any{"tool": "Read"}))
	addRaw(t, s, activity(t, "assistant.message", "t1", 3, map[string]any{"text": "hello"}))

	sink := &wsSink{}
	c := newActivityClient(s, sink.send)
	if !c.handle(cmd("subscribe", "t1")) {
		t.Fatal("subscribe not handled")
	}
	addRaw(t, s, activity(t, "tool.finished", "t1", 4, map[string]any{"tool": "Read"}))
	addRaw(t, s, activity(t, "task.finished", "t1", 5, nil))

	msgs := sink.all()
	if len(msgs) != 3 || msgs[0].Op != "backlog" || msgs[1].Op != "event" || msgs[2].Op != "event" {
		t.Fatalf("got %+v", msgs)
	}
	if !sink.crit[0] || sink.crit[1] {
		t.Fatalf("backlog must be critical and live events droppable: %v", sink.crit)
	}
	var seqs []int64
	for _, e := range msgs[0].Events {
		seqs = append(seqs, seqOf(t, e))
	}
	seqs = append(seqs, seqOf(t, msgs[1].Event), seqOf(t, msgs[2].Event))
	if fmt.Sprint(seqs) != "[1 2 3 4 5]" {
		t.Fatalf("seqs=%v want 1..5 exactly once in order", seqs)
	}
	if msgs[0].Finished || msgs[0].Truncated != 0 || msgs[0].TaskID != "t1" {
		t.Fatalf("backlog=%+v", msgs[0])
	}
	// The raw event is relayed as published (unknown fields kept).
	if !strings.Contains(string(msgs[0].Events[2]), `"text":"hello"`) {
		t.Fatalf("assistant message text lost: %s", msgs[0].Events[2])
	}

	// A later subscriber sees the finished flag.
	late := &wsSink{}
	newActivityClient(s, late.send).handle(cmd("subscribe", "t1"))
	if m := late.all()[0]; !m.Finished || len(m.Events) != 5 {
		t.Fatalf("late backlog=%+v", m)
	}
}

func TestActivitySubscribeBeforeFirstEvent(t *testing.T) {
	s, _ := newTestActivityStore()
	sink := &wsSink{}
	newActivityClient(s, sink.send).handle(cmd("subscribe", "t1"))
	addRaw(t, s, activity(t, "task.started", "t1", 1, nil))
	msgs := sink.all()
	if len(msgs) != 2 || msgs[0].Op != "backlog" || len(msgs[0].Events) != 0 || msgs[1].Op != "event" {
		t.Fatalf("got %+v", msgs)
	}
}

func TestActivityOnlySubscribedTasksDelivered(t *testing.T) {
	s, _ := newTestActivityStore()
	a, b := &wsSink{}, &wsSink{}
	ca, cb := newActivityClient(s, a.send), newActivityClient(s, b.send)
	ca.handle(cmd("subscribe", "ta"))
	cb.handle(cmd("subscribe", "tb"))
	for i := int64(1); i <= 3; i++ {
		addRaw(t, s, activity(t, "task.heartbeat", "ta", i, nil))
		addRaw(t, s, activity(t, "task.heartbeat", "tb", i, nil))
		addRaw(t, s, activity(t, "task.heartbeat", "tc", i, nil))
	}
	for name, k := range map[string]*wsSink{"ta": a, "tb": b} {
		msgs := k.all()
		if len(msgs) != 4 {
			t.Fatalf("%s: got %d msgs", name, len(msgs))
		}
		for _, m := range msgs {
			if m.TaskID != name {
				t.Fatalf("%s received %s's activity", name, m.TaskID)
			}
			if m.Op == "event" {
				var ev activityEvent
				json.Unmarshal(m.Event, &ev)
				if ev.TaskID != name {
					t.Fatalf("%s received event of %s", name, ev.TaskID)
				}
			}
		}
	}

	// Unsubscribe stops delivery.
	ca.handle(cmd("unsubscribe", "ta"))
	addRaw(t, s, activity(t, "task.heartbeat", "ta", 4, nil))
	msgs := a.all()
	if last := msgs[len(msgs)-1]; last.Op != "unsubscribed" || last.TaskID != "ta" {
		t.Fatalf("last=%+v", last)
	}

	// Closing the client removes every watch from the store.
	cb.close()
	s.mu.Lock()
	n := len(s.watchers)
	s.mu.Unlock()
	if n != 0 {
		t.Fatalf("watchers left after close: %d", n)
	}
	cb.handle(cmd("subscribe", "tb"))
	if len(b.all()) != 4 {
		t.Fatal("subscribe after close must be ignored")
	}
}

func TestActivityPerClientWatchLimit(t *testing.T) {
	s, _ := newTestActivityStore()
	sink := &wsSink{}
	c := newActivityClient(s, sink.send)
	for i := 0; i < activityMaxWatchesPerWS; i++ {
		c.handle(cmd("subscribe", fmt.Sprintf("t%d", i)))
	}
	c.handle(cmd("subscribe", "one-too-many"))
	msgs := sink.all()
	if last := msgs[len(msgs)-1]; last.Op != "error" || last.TaskID != "one-too-many" {
		t.Fatalf("expected limit error, got %+v", last)
	}
	// Re-subscribing to a watched task is not a new watch: fresh backlog.
	c.handle(cmd("subscribe", "t0"))
	if last := sink.all()[len(sink.all())-1]; last.Op != "backlog" || last.TaskID != "t0" {
		t.Fatalf("re-subscribe got %+v", last)
	}
	// Unsubscribing frees a slot.
	c.handle(cmd("unsubscribe", "t1"))
	c.handle(cmd("subscribe", "one-too-many"))
	if last := sink.all()[len(sink.all())-1]; last.Op != "backlog" {
		t.Fatalf("expected backlog after freeing a slot, got %+v", last)
	}
	if len(c.watches) != activityMaxWatchesPerWS {
		t.Fatalf("watches=%d", len(c.watches))
	}
}

func TestActivityCommandValidation(t *testing.T) {
	s, _ := newTestActivityStore()
	sink := &wsSink{}
	c := newActivityClient(s, sink.send)
	if c.handle([]byte(`{"action":"dispatch","knight":"galahad"}`)) {
		t.Fatal("dispatch must not be treated as an activity command")
	}
	if c.handle([]byte(`not json`)) || c.handle([]byte(`{"subscribe":"running"}`)) {
		t.Fatal("unknown commands must not be handled")
	}
	for _, id := range []string{"", strings.Repeat("x", maxTaskIDLen+1), "bad\nid"} {
		if !c.handle(cmd("subscribe", id)) {
			t.Fatal("invalid subscribe should still be consumed")
		}
	}
	for _, m := range sink.all() {
		if m.Op != "error" || m.TaskID != "" {
			t.Fatalf("got %+v", m)
		}
	}
	if len(c.watches) != 0 {
		t.Fatal("invalid ids must not be watched")
	}
}

func TestActivityRingBufferBounded(t *testing.T) {
	s, _ := newTestActivityStore()
	for i := int64(1); i <= activityBufferSize+50; i++ {
		addRaw(t, s, activity(t, "task.heartbeat", "t1", i, nil))
	}
	sink := &wsSink{}
	newActivityClient(s, sink.send).handle(cmd("subscribe", "t1"))
	bl := sink.all()[0]
	if len(bl.Events) != activityBufferSize || bl.Truncated != 50 {
		t.Fatalf("events=%d truncated=%d", len(bl.Events), bl.Truncated)
	}
	if first, last := seqOf(t, bl.Events[0]), seqOf(t, bl.Events[len(bl.Events)-1]); first != 51 || last != activityBufferSize+50 {
		t.Fatalf("first=%d last=%d", first, last)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.bytes != s.buffers["t1"].bytes || s.bytes <= 0 {
		t.Fatalf("byte accounting: store=%d buffer=%d", s.bytes, s.buffers["t1"].bytes)
	}
}

func TestActivityRetention(t *testing.T) {
	s, clk := newTestActivityStore()
	addRaw(t, s, activity(t, "task.started", "done", 1, nil))
	addRaw(t, s, activity(t, "task.finished", "done", 2, nil))
	addRaw(t, s, activity(t, "task.started", "running", 1, nil))

	clk.add(activityFinishedRetention - time.Second)
	addRaw(t, s, activity(t, "task.heartbeat", "running", 2, nil))
	s.sweep()
	if _, ok := s.buffers["done"]; !ok {
		t.Fatal("finished task dropped before its retention")
	}
	clk.add(2 * time.Second)
	s.sweep()
	if _, ok := s.buffers["done"]; ok {
		t.Fatal("finished task kept after 15 minutes")
	}
	if _, ok := s.buffers["running"]; !ok {
		t.Fatal("running task dropped")
	}
	clk.add(activityIdleRetention + time.Second)
	s.sweep()
	if len(s.buffers) != 0 || s.bytes != 0 {
		t.Fatalf("idle task kept: %d buffers, %d bytes", len(s.buffers), s.bytes)
	}
}

func TestActivityStoreEvictsWithinBudget(t *testing.T) {
	s, clk := newTestActivityStore()
	s.maxTasks = 3
	addRaw(t, s, activity(t, "task.started", "watched", 1, nil))
	clk.add(time.Second)
	addRaw(t, s, activity(t, "task.started", "old", 1, nil))
	clk.add(time.Second)
	addRaw(t, s, activity(t, "task.started", "fin", 1, nil))
	addRaw(t, s, activity(t, "task.finished", "fin", 2, nil))
	newActivityClient(s, (&wsSink{}).send).handle(cmd("subscribe", "watched"))

	clk.add(time.Second)
	addRaw(t, s, activity(t, "task.started", "new1", 1, nil)) // evicts the finished task
	if _, ok := s.buffers["fin"]; ok {
		t.Fatal("finished task should be evicted first")
	}
	clk.add(time.Second)
	addRaw(t, s, activity(t, "task.started", "new2", 1, nil)) // then the oldest unwatched
	if _, ok := s.buffers["old"]; ok {
		t.Fatal("oldest unwatched task should be evicted next")
	}
	if _, ok := s.buffers["watched"]; !ok {
		t.Fatal("watched task evicted before unwatched ones")
	}

	// Byte budget.
	s.maxTasks = 100
	s.maxBytes = 3 * len(activity(t, "task.started", "new2", 1, nil))
	addRaw(t, s, activity(t, "task.started", "new3", 1, nil))
	if s.bytes > s.maxBytes {
		t.Fatalf("bytes=%d over budget %d", s.bytes, s.maxBytes)
	}
	if _, ok := s.buffers["new3"]; !ok {
		t.Fatal("the task being appended to must not be evicted")
	}
}

func TestActivityGapMarkerWhenEventsDropped(t *testing.T) {
	s, _ := newTestActivityStore()
	dropping := false
	sink := &wsSink{}
	sink.fail = func(m ActivityMessage) bool { return dropping && m.Op != "backlog" }
	newActivityClient(s, sink.send).handle(cmd("subscribe", "t1"))
	addRaw(t, s, activity(t, "task.heartbeat", "t1", 1, nil))
	dropping = true
	for i := int64(2); i <= 4; i++ {
		addRaw(t, s, activity(t, "task.heartbeat", "t1", i, nil))
	}
	dropping = false
	addRaw(t, s, activity(t, "task.heartbeat", "t1", 5, nil))

	msgs := sink.all()
	ops := []string{}
	for _, m := range msgs {
		ops = append(ops, m.Op)
	}
	if fmt.Sprint(ops) != "[backlog event gap event]" {
		t.Fatalf("ops=%v", ops)
	}
	if g := msgs[2]; g.FromSeq != 2 || g.ToSeq != 4 || g.Count != 3 {
		t.Fatalf("gap=%+v", g)
	}
	if seqOf(t, msgs[3].Event) != 5 {
		t.Fatalf("event after gap=%+v", msgs[3])
	}
}

func TestActivitySlowClientDoesNotBlockCallbacks(t *testing.T) {
	s, _ := newTestActivityStore()
	conn := newSlowConn() // never writes until gated
	w := newWSWriter(conn, 8, nil)
	go w.run()
	defer func() { w.close(); conn.gate <- struct{}{}; waitExit(t, w) }()
	c := newActivityClient(s, w.enqueue)
	c.handle(cmd("subscribe", "t1"))
	<-conn.started // the writer is stuck on the backlog

	fast := &wsSink{}
	newActivityClient(s, fast.send).handle(cmd("subscribe", "t1"))

	done := make(chan struct{})
	go func() {
		for i := int64(1); i <= 500; i++ {
			raw := activity(t, "task.heartbeat", "t1", i, nil)
			ev, _ := parseActivityEvent(raw, "Galahad")
			s.add(ev, raw)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("activity callbacks blocked by a slow client")
	}
	if n := len(fast.all()); n != 501 {
		t.Fatalf("fast client got %d msgs, want backlog + 500", n)
	}
	w.qmu.Lock()
	q := len(w.queue)
	w.qmu.Unlock()
	if q > 8 || w.isClosed() {
		t.Fatalf("slow client queue=%d closed=%v", q, w.isClosed())
	}
}
