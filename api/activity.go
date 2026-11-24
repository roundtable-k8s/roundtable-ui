package main

import (
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// Live task activity stream (#184, #213).
//
// The API keeps a ring buffer of the last activityBufferSize activity events
// (`<prefix>.activity.<Knight>.<taskId>`) of every task, kept for
// activityFinishedRetention after task.finished. A browser watches a task over
// /api/ws:
//
//	→ {"subscribe":"activity","taskId":"…"}
//	← activity {op:"backlog", taskId, events:[…], truncated:n, finished:bool}
//	← activity {op:"event",   taskId, event:{…}}            (live, in order)
//	← activity {op:"gap",     taskId, fromSeq, toSeq, count} (events dropped for this client)
//	→ {"unsubscribe":"activity","taskId":"…"}
//	← activity {op:"unsubscribed", taskId}
//	← activity {op:"error",   taskId, error}                 (invalid id, too many watches)
//
// Only events of the tasks a client watches are sent to it. The backlog is
// delivered atomically with the registration, so a viewer that subscribes
// mid-run gets the backlog first and then every later event exactly once.
// Live events are droppable: they go through the client's bounded wsWriter
// queue and never block the NATS callback. When an event cannot be queued the
// client gets a gap marker (seq range) before the next one it does receive;
// clients should also treat a seq discontinuity as a gap, since the writer may
// evict an already queued droppable message.

const (
	activityBufferSize        = 200
	activityFinishedRetention = 15 * time.Minute
	// activityIdleRetention drops buffers of tasks that never sent
	// task.finished (pod died, event lost).
	activityIdleRetention   = time.Hour
	activityMaxTasks        = 1000
	activityMaxBytes        = 64 << 20
	activityMaxWatchesPerWS = 10
)

// activityItem is one buffered event: its seq and the raw payload as
// published by the knight (bounded to maxActivityEventBytes, valid JSON).
type activityItem struct {
	seq  int64
	data json.RawMessage
}

// activityBuffer is the ring buffer of one task.
type activityBuffer struct {
	items      []activityItem // ring of capacity activityBufferSize
	head       int            // index of the oldest item
	n          int
	bytes      int
	truncated  int64 // events evicted from the ring
	finishedAt time.Time
	lastAt     time.Time // local receipt time of the last event
}

func (b *activityBuffer) push(it activityItem, capacity int) (freed int) {
	if b.items == nil {
		b.items = make([]activityItem, capacity)
	}
	if b.n == capacity {
		old := b.items[b.head]
		freed = len(old.data)
		b.items[b.head] = it
		b.head = (b.head + 1) % capacity
		b.truncated++
	} else {
		b.items[(b.head+b.n)%capacity] = it
		b.n++
	}
	b.bytes += len(it.data) - freed
	return freed
}

func (b *activityBuffer) list() []activityItem {
	out := make([]activityItem, 0, b.n)
	for i := 0; i < b.n; i++ {
		out = append(out, b.items[(b.head+i)%len(b.items)])
	}
	return out
}

// activityBacklog is what a new watcher receives first.
type activityBacklog struct {
	events    []activityItem
	truncated int64
	finished  bool
}

// activityWatcher receives a task's events. Callbacks run with the store lock
// held, so they are serialized per store and must not block or call back into
// the store.
type activityWatcher struct {
	onBacklog func(activityBacklog)
	onEvent   func(activityItem)
}

// activityStore holds the per-task ring buffers and the watchers. It is safe
// for concurrent use.
type activityStore struct {
	mu       sync.Mutex
	buffers  map[string]*activityBuffer
	watchers map[string]map[int]*activityWatcher
	nextID   int
	bytes    int

	capacity          int
	maxTasks          int
	maxBytes          int
	finishedRetention time.Duration
	idleRetention     time.Duration
	now               func() time.Time
}

func newActivityStore() *activityStore {
	return &activityStore{
		buffers:           map[string]*activityBuffer{},
		watchers:          map[string]map[int]*activityWatcher{},
		capacity:          activityBufferSize,
		maxTasks:          activityMaxTasks,
		maxBytes:          activityMaxBytes,
		finishedRetention: activityFinishedRetention,
		idleRetention:     activityIdleRetention,
		now:               time.Now,
	}
}

// add buffers one parsed event (raw is its original payload) and fans it out
// to the task's watchers.
func (s *activityStore) add(ev activityEvent, raw []byte) {
	if ev.TaskID == "" || len(ev.TaskID) > maxTaskIDLen || len(raw) > maxActivityEventBytes {
		return
	}
	now := s.now()
	it := activityItem{seq: ev.Seq, data: append(json.RawMessage(nil), raw...)}

	s.mu.Lock()
	defer s.mu.Unlock()
	b, ok := s.buffers[ev.TaskID]
	if !ok {
		b = &activityBuffer{}
		s.buffers[ev.TaskID] = b
	}
	before := b.bytes
	b.push(it, s.capacity)
	s.bytes += b.bytes - before
	b.lastAt = now
	switch ev.Type {
	case "task.finished":
		b.finishedAt = now
	case "task.started":
		b.finishedAt = time.Time{} // redelivered: running again
	}
	s.evictLocked(ev.TaskID)
	for _, w := range s.watchers[ev.TaskID] {
		w.onEvent(it)
	}
}

// evictLocked drops whole buffers while over the task or byte budget:
// finished unwatched tasks first, then unwatched, then the least recently
// updated. keep is never evicted.
func (s *activityStore) evictLocked(keep string) {
	for len(s.buffers) > s.maxTasks || s.bytes > s.maxBytes {
		victim := ""
		var vb *activityBuffer
		rank := func(id string, b *activityBuffer) int {
			r := 0
			if len(s.watchers[id]) > 0 {
				r += 2
			}
			if b.finishedAt.IsZero() {
				r++
			}
			return r
		}
		for id, b := range s.buffers {
			if id == keep {
				continue
			}
			if vb == nil || rank(id, b) < rank(victim, vb) ||
				(rank(id, b) == rank(victim, vb) && b.lastAt.Before(vb.lastAt)) {
				victim, vb = id, b
			}
		}
		if vb == nil {
			return
		}
		s.dropLocked(victim)
	}
}

func (s *activityStore) dropLocked(taskID string) {
	if b, ok := s.buffers[taskID]; ok {
		s.bytes -= b.bytes
		delete(s.buffers, taskID)
	}
}

// sweep drops buffers finished more than finishedRetention ago, and buffers
// of tasks that sent nothing for idleRetention.
func (s *activityStore) sweep() {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, b := range s.buffers {
		if (!b.finishedAt.IsZero() && now.Sub(b.finishedAt) > s.finishedRetention) ||
			now.Sub(b.lastAt) > s.idleRetention {
			s.dropLocked(id)
		}
	}
}

// watch registers w for taskID and delivers the backlog (possibly empty)
// atomically with the registration. It returns the unwatch func.
func (s *activityStore) watch(taskID string, w *activityWatcher) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextID
	s.nextID++
	if s.watchers[taskID] == nil {
		s.watchers[taskID] = map[int]*activityWatcher{}
	}
	s.watchers[taskID][id] = w
	var bl activityBacklog
	if b, ok := s.buffers[taskID]; ok {
		bl = activityBacklog{events: b.list(), truncated: b.truncated, finished: !b.finishedAt.IsZero()}
	}
	w.onBacklog(bl)
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.watchers[taskID], id)
		if len(s.watchers[taskID]) == 0 {
			delete(s.watchers, taskID)
		}
	}
}

// ── WebSocket side ──

// ActivityMessage is the payload of an `activity` WebSocket event.
type ActivityMessage struct {
	Op        string            `json:"op"` // backlog | event | gap | unsubscribed | error
	TaskID    string            `json:"taskId"`
	Events    []json.RawMessage `json:"events,omitempty"`
	Event     json.RawMessage   `json:"event,omitempty"`
	Truncated int64             `json:"truncated,omitempty"` // backlog: older events evicted from the buffer
	Finished  bool              `json:"finished,omitempty"`  // backlog: task.finished already seen
	FromSeq   int64             `json:"fromSeq,omitempty"`   // gap
	ToSeq     int64             `json:"toSeq,omitempty"`     // gap
	Count     int               `json:"count,omitempty"`     // gap: events dropped
	Error     string            `json:"error,omitempty"`
}

func activityWSEvent(m ActivityMessage) []byte {
	payload, _ := json.Marshal(m)
	data, _ := json.Marshal(TaskEvent{
		Type:      "activity",
		Subject:   "activity",
		Data:      payload,
		Timestamp: time.Now().UTC(),
	})
	return data
}

// activityCommand is a client → server activity (un)subscribe request.
type activityCommand struct {
	Subscribe   string `json:"subscribe"`
	Unsubscribe string `json:"unsubscribe"`
	TaskID      string `json:"taskId"`
}

// validActivityTaskID accepts non-empty ids of bounded length without
// control characters.
func validActivityTaskID(id string) bool {
	if id == "" || len(id) > maxTaskIDLen {
		return false
	}
	return !strings.ContainsFunc(id, func(r rune) bool { return r < 0x20 || r == 0x7f })
}

// activityClient tracks the tasks one WebSocket client watches.
type activityClient struct {
	store      *activityStore
	send       func(data []byte, critical bool) bool
	maxWatches int

	mu      sync.Mutex
	watches map[string]func()
	closed  bool
}

func newActivityClient(store *activityStore, send func([]byte, bool) bool) *activityClient {
	return &activityClient{store: store, send: send, maxWatches: activityMaxWatchesPerWS, watches: map[string]func(){}}
}

// handle processes msg if it is an activity command and reports whether it was.
func (c *activityClient) handle(msg []byte) bool {
	var cmd activityCommand
	if json.Unmarshal(msg, &cmd) != nil {
		return false
	}
	switch {
	case cmd.Subscribe == "activity":
		c.subscribe(cmd.TaskID)
	case cmd.Unsubscribe == "activity":
		c.unsubscribe(cmd.TaskID)
	default:
		return false
	}
	return true
}

func (c *activityClient) sendError(taskID, msg string) {
	if !validActivityTaskID(taskID) {
		taskID = ""
	}
	c.send(activityWSEvent(ActivityMessage{Op: "error", TaskID: taskID, Error: msg}), true)
}

func (c *activityClient) subscribe(taskID string) {
	if !validActivityTaskID(taskID) {
		c.sendError(taskID, "invalid taskId")
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	if unwatch, ok := c.watches[taskID]; ok {
		// Re-subscribe: start over with a fresh backlog.
		unwatch()
		delete(c.watches, taskID)
	} else if len(c.watches) >= c.maxWatches {
		c.sendError(taskID, "too many watched tasks")
		return
	}
	c.watches[taskID] = c.store.watch(taskID, c.watcher(taskID))
}

// watcher builds the store callbacks for one watched task. Callbacks are
// serialized by the store lock, so the gap state needs no lock of its own.
func (c *activityClient) watcher(taskID string) *activityWatcher {
	var gapFrom, gapTo int64
	gapCount := 0
	return &activityWatcher{
		onBacklog: func(bl activityBacklog) {
			events := make([]json.RawMessage, len(bl.events))
			for i, it := range bl.events {
				events[i] = it.data
			}
			// Critical: it is the reply to the subscribe; without it the
			// panel would show live events with no history.
			c.send(activityWSEvent(ActivityMessage{
				Op: "backlog", TaskID: taskID, Events: events,
				Truncated: bl.truncated, Finished: bl.finished,
			}), true)
		},
		onEvent: func(it activityItem) {
			if gapCount > 0 {
				if c.send(activityWSEvent(ActivityMessage{Op: "gap", TaskID: taskID, FromSeq: gapFrom, ToSeq: gapTo, Count: gapCount}), false) {
					gapFrom, gapTo, gapCount = 0, 0, 0
				} else {
					gapTo = it.seq
					gapCount++
					return
				}
			}
			if !c.send(activityWSEvent(ActivityMessage{Op: "event", TaskID: taskID, Event: it.data}), false) {
				if gapCount == 0 {
					gapFrom = it.seq
				}
				gapTo = it.seq
				gapCount++
			}
		},
	}
}

func (c *activityClient) unsubscribe(taskID string) {
	if !validActivityTaskID(taskID) {
		c.sendError(taskID, "invalid taskId")
		return
	}
	c.mu.Lock()
	unwatch, ok := c.watches[taskID]
	delete(c.watches, taskID)
	c.mu.Unlock()
	if ok {
		unwatch()
	}
	c.send(activityWSEvent(ActivityMessage{Op: "unsubscribed", TaskID: taskID}), true)
}

// close drops every watch; later commands are ignored.
func (c *activityClient) close() {
	c.mu.Lock()
	c.closed = true
	watches := c.watches
	c.watches = map[string]func(){}
	c.mu.Unlock()
	for _, unwatch := range watches {
		unwatch()
	}
}
