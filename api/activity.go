package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
)

// Live task activity stream (#184, #213).
//
// The API keeps the recent activity events of every task in a per-task ring
// buffer and relays them to the WebSocket clients that watch that task:
//
//	client → {"subscribe":"activity","taskId":"…"}
//	server → {"type":"activity","data":{"op":"backlog","taskId":"…","task":{…},"events":[…],"dropped":N}}
//	server → {"type":"activity","data":{"op":"event","taskId":"…","task":{…},"event":{…}}}   (live)
//	client → {"unsubscribe":"activity","taskId":"…"}
//
// A client only ever receives the events of the tasks it watches. The backlog
// (the last activityRingSize events, heartbeats excluded) comes first, then
// live events, atomically with the registration so nothing falls between the
// two. Live events are droppable: the wsWriter evicts them when a client
// cannot keep up. Every event carries the knight's per-task `seq`, so a client
// spots both knight→API loss and API→client drops as a seq gap; backlog items
// carry the gap the API saw before them in `gap`.
//
// Events are sanitized before buffering (#188): unknown fields are dropped,
// text fields are bounded (with `truncated`) and run through redactSecrets.

const (
	activityRingSize             = 200
	activityFinishedRetention    = 15 * time.Minute
	activityIdleRetention        = time.Hour
	activityMaxTasks             = 2000
	activityMaxWatchedPerClient  = 10
	activitySubscribeRate        = 5.0 // subscribe commands per second, per client
	activitySubscribeBurst       = 20
	activityErrWatchLimit        = "watch_limit"
	activityErrInvalidTaskID     = "invalid_task_id"
	activityErrRateLimited       = "rate_limited"
	activityOpBacklog            = "backlog"
	activityOpEvent              = "event"
	activityOpError              = "error"
	activityTypeHeartbeat        = "task.heartbeat"
	activityTypeTaskStarted      = "task.started"
	activityTypeTaskFinished     = "task.finished"
	activityTypeToolStarted      = "tool.started"
	activityTypeToolFinished     = "tool.finished"
	activityTypeAssistantMessage = "assistant.message"
)

// ActivityItem is one sanitized activity event as sent to browsers.
type ActivityItem struct {
	Type      string `json:"type"`
	Timestamp string `json:"ts"`
	Seq       int64  `json:"seq"`
	// Gap is the number of seq numbers the API never received right before
	// this event (backlog only; live clients compute gaps themselves).
	Gap       int64 `json:"gap,omitempty"`
	Truncated bool  `json:"truncated,omitempty"`

	Tool          string `json:"tool,omitempty"`
	ToolCallID    string `json:"toolCallId,omitempty"`
	ArgsSummary   string `json:"argsSummary,omitempty"`
	DurationMs    *int64 `json:"durationMs,omitempty"`
	IsError       *bool  `json:"isError,omitempty"`
	OutputPreview string `json:"outputPreview,omitempty"`
	Preview       string `json:"preview,omitempty"`

	Turns        *int     `json:"turns,omitempty"`
	InputTokens  *int64   `json:"inputTokens,omitempty"`
	OutputTokens *int64   `json:"outputTokens,omitempty"`
	CostUSD      *float64 `json:"costUsd,omitempty"`
	CurrentTool  string   `json:"currentTool,omitempty"`

	Success    *bool  `json:"success,omitempty"`
	ErrorClass string `json:"errorClass,omitempty"`
}

// ActivityTaskInfo is the header of a watched task: identity plus the latest
// counters and, once finished, the outcome.
type ActivityTaskInfo struct {
	TaskID    string `json:"taskId"`
	Knight    string `json:"knight,omitempty"`
	Pod       string `json:"pod,omitempty"`
	Node      string `json:"node,omitempty"`
	RunID     string `json:"runId,omitempty"`
	ChainName string `json:"chainName,omitempty"`
	StepName  string `json:"stepName,omitempty"`
	Model     string `json:"model,omitempty"`

	StartedAt   string `json:"startedAt,omitempty"`
	LastEventAt string `json:"lastEventAt,omitempty"`
	Seq         int64  `json:"seq"`

	Turns        *int     `json:"turns,omitempty"`
	InputTokens  *int64   `json:"inputTokens,omitempty"`
	OutputTokens *int64   `json:"outputTokens,omitempty"`
	CostUSD      *float64 `json:"costUsd,omitempty"`

	Finished   bool   `json:"finished,omitempty"`
	Success    *bool  `json:"success,omitempty"`
	ErrorClass string `json:"errorClass,omitempty"`
	DurationMs *int64 `json:"durationMs,omitempty"`
	FinishedAt string `json:"finishedAt,omitempty"`
}

// ActivityMsg is the payload of an `activity` WebSocket event.
type ActivityMsg struct {
	Op     string            `json:"op"` // backlog | event | error
	TaskID string            `json:"taskId"`
	Task   *ActivityTaskInfo `json:"task,omitempty"`
	Events []ActivityItem    `json:"events,omitempty"`
	Event  *ActivityItem     `json:"event,omitempty"`
	// Dropped counts events that fell out of the ring buffer (backlog only).
	Dropped int    `json:"dropped,omitempty"`
	Error   string `json:"error,omitempty"`
}

type taskActivity struct {
	info       ActivityTaskInfo
	items      []ActivityItem // oldest first, at most activityRingSize
	dropped    int
	lastSeq    int64
	lastAt     time.Time // local receipt time of the last event
	finishedAt time.Time // local; zero while running
}

type activityWatcher struct {
	taskID string
	fn     func(ActivityMsg)
}

// activityStore buffers recent activity per task and fans it out to watchers.
// Watcher callbacks run with the store lock held (so backlog and live events
// reach a watcher in order); they must not block or call back into the store.
type activityStore struct {
	mu       sync.Mutex
	tasks    map[string]*taskActivity
	watchers map[string]map[int]func(ActivityMsg)
	nextID   int

	ringSize          int
	maxTasks          int
	finishedRetention time.Duration
	idleRetention     time.Duration
	now               func() time.Time
}

func newActivityStore() *activityStore {
	return &activityStore{
		tasks:             map[string]*taskActivity{},
		watchers:          map[string]map[int]func(ActivityMsg){},
		ringSize:          activityRingSize,
		maxTasks:          activityMaxTasks,
		finishedRetention: activityFinishedRetention,
		idleRetention:     activityIdleRetention,
		now:               time.Now,
	}
}

// boundText cuts s to max runes, reporting whether it was cut.
func boundText(s string, max int) (string, bool) {
	if utf8.RuneCountInString(s) <= max {
		return s, false
	}
	return string([]rune(s)[:max]), true
}

// cleanPreview bounds and redacts an untrusted text field.
func cleanPreview(s string, max int, truncated *bool) string {
	if s == "" {
		return ""
	}
	out, cut := boundText(s, max)
	if cut {
		*truncated = true
	}
	return redactSecrets(out)
}

// validActivityTaskID accepts the task ids a client may watch: non-empty,
// bounded, printable, no whitespace.
func validActivityTaskID(id string) bool {
	if id == "" || len(id) > maxTaskIDLen || !utf8.ValidString(id) {
		return false
	}
	for _, r := range id {
		if unicode.IsSpace(r) || !unicode.IsPrint(r) {
			return false
		}
	}
	return true
}

// handleActivity applies one raw activity message. subjectKnight is the
// <Knight> token of the subject, used when the payload lacks a knight.
func (s *activityStore) handleActivity(data []byte, subjectKnight string) {
	if len(data) > maxActivityEventBytes {
		return
	}
	var ev activityEvent
	if err := json.Unmarshal(data, &ev); err != nil {
		return
	}
	if ev.V > activityVersion || !validActivityTaskID(ev.TaskID) {
		return
	}
	if ev.Knight == "" {
		ev.Knight = subjectKnight
	}
	switch ev.Type {
	case activityTypeTaskStarted, activityTypeHeartbeat, activityTypeToolStarted,
		activityTypeToolFinished, activityTypeAssistantMessage, activityTypeTaskFinished:
	default:
		return
	}
	s.apply(ev)
}

func (s *activityStore) apply(ev activityEvent) {
	now := s.now()
	ts := now.UTC().Format(time.RFC3339Nano)
	if t, err := time.Parse(time.RFC3339Nano, ev.Timestamp); err == nil {
		ts = t.UTC().Format(time.RFC3339Nano)
	}

	item := ActivityItem{Type: ev.Type, Timestamp: ts, Seq: ev.Seq, Truncated: ev.Truncated}
	item.Tool = cleanPreview(ev.Tool, maxActivityArgs, &item.Truncated)
	item.ToolCallID = cleanPreview(ev.ToolCallID, maxActivityArgs, &item.Truncated)
	item.ArgsSummary = cleanPreview(ev.ArgsSummary, maxActivityArgs, &item.Truncated)
	item.OutputPreview = cleanPreview(ev.OutputPreview, maxActivityPreview, &item.Truncated)
	item.Preview = cleanPreview(ev.Preview, maxActivityPreview, &item.Truncated)
	item.CurrentTool = cleanPreview(ev.CurrentTool, maxActivityArgs, &item.Truncated)
	item.ErrorClass = cleanPreview(ev.ErrorClass, maxActivityArgs, &item.Truncated)
	item.DurationMs, item.IsError, item.Success = ev.DurationMs, ev.IsError, ev.Success
	item.Turns, item.InputTokens, item.OutputTokens, item.CostUSD = ev.Turns, ev.InputTokens, ev.OutputTokens, ev.CostUSD

	s.mu.Lock()
	defer s.mu.Unlock()

	ta, ok := s.tasks[ev.TaskID]
	if !ok {
		s.evictLocked()
		ta = &taskActivity{info: ActivityTaskInfo{TaskID: ev.TaskID}}
		s.tasks[ev.TaskID] = ta
	}
	ta.lastAt = now

	switch {
	case ev.Type == activityTypeTaskStarted:
		// A start (or a redelivery's start) begins a new seq run.
		ta.lastSeq = ev.Seq
		ta.finishedAt = time.Time{}
		ta.info.Finished, ta.info.Success, ta.info.ErrorClass = false, nil, ""
		ta.info.DurationMs, ta.info.FinishedAt = nil, ""
		ta.info.StartedAt = ts
	case ev.Seq > 0 && ta.lastSeq > 0 && ev.Seq > ta.lastSeq+1:
		item.Gap = ev.Seq - ta.lastSeq - 1
		ta.lastSeq = ev.Seq
	case ev.Seq > ta.lastSeq:
		ta.lastSeq = ev.Seq
	}

	info := &ta.info
	set := func(dst *string, v string) {
		if v != "" {
			*dst = bound(v, maxActivityArgs)
		}
	}
	set(&info.Knight, ev.Knight)
	set(&info.Pod, ev.Pod)
	set(&info.Node, ev.Node)
	set(&info.RunID, ev.RunID)
	set(&info.ChainName, ev.Chain)
	set(&info.StepName, ev.Step)
	set(&info.Model, ev.Model)
	if info.StartedAt == "" {
		info.StartedAt = ts
	}
	info.LastEventAt = ts
	info.Seq = ta.lastSeq
	if ev.Turns != nil {
		info.Turns = ev.Turns
	}
	if ev.InputTokens != nil {
		info.InputTokens = ev.InputTokens
	}
	if ev.OutputTokens != nil {
		info.OutputTokens = ev.OutputTokens
	}
	if ev.CostUSD != nil {
		info.CostUSD = ev.CostUSD
	}
	if ev.Type == activityTypeTaskFinished {
		ta.finishedAt = now
		info.Finished = true
		info.Success, info.ErrorClass, info.DurationMs = item.Success, item.ErrorClass, item.DurationMs
		info.FinishedAt = ts
	}

	// Heartbeats update the header only; they would crowd the timeline.
	if ev.Type != activityTypeHeartbeat {
		ta.items = append(ta.items, item)
		if over := len(ta.items) - s.ringSize; over > 0 {
			ta.items = append([]ActivityItem(nil), ta.items[over:]...)
			ta.dropped += over
		}
	}

	ws := s.watchers[ev.TaskID]
	if len(ws) == 0 {
		return
	}
	hdr := ta.info
	it := item
	msg := ActivityMsg{Op: activityOpEvent, TaskID: ev.TaskID, Task: &hdr, Event: &it}
	for _, fn := range ws {
		fn(msg)
	}
}

// evictLocked makes room for one more task: finished tasks first, then the
// one idle longest. Watched tasks are evicted last; their watchers stay
// registered and simply see the task start over.
func (s *activityStore) evictLocked() {
	if len(s.tasks) < s.maxTasks {
		return
	}
	var victim string
	var vt *taskActivity
	rank := func(id string, t *taskActivity) int {
		r := 0
		if t.finishedAt.IsZero() {
			r++
		}
		if len(s.watchers[id]) > 0 {
			r += 2
		}
		return r
	}
	for id, t := range s.tasks {
		if vt == nil || rank(id, t) < rank(victim, vt) ||
			(rank(id, t) == rank(victim, vt) && t.lastAt.Before(vt.lastAt)) {
			victim, vt = id, t
		}
	}
	if vt != nil {
		delete(s.tasks, victim)
	}
}

// backlogLocked builds the backlog message of a task.
func (s *activityStore) backlogLocked(taskID string) ActivityMsg {
	msg := ActivityMsg{Op: activityOpBacklog, TaskID: taskID, Events: []ActivityItem{}}
	if ta, ok := s.tasks[taskID]; ok {
		hdr := ta.info
		msg.Task = &hdr
		msg.Events = append(msg.Events, ta.items...)
		msg.Dropped = ta.dropped
	}
	return msg
}

// watch registers fn for taskID's events and returns an unwatch func. The
// backlog is delivered to fn first, atomically with the registration. A task
// that has no events yet can be watched; its events arrive live.
func (s *activityStore) watch(taskID string, fn func(ActivityMsg)) func() {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := s.nextID
	s.nextID++
	ws := s.watchers[taskID]
	if ws == nil {
		ws = map[int]func(ActivityMsg){}
		s.watchers[taskID] = ws
	}
	ws[id] = fn
	fn(s.backlogLocked(taskID))
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if ws := s.watchers[taskID]; ws != nil {
				delete(ws, id)
				if len(ws) == 0 {
					delete(s.watchers, taskID)
				}
			}
		})
	}
}

// sweep drops tasks finished longer than finishedRetention ago and tasks idle
// longer than idleRetention, unless someone is watching them.
func (s *activityStore) sweep() {
	now := s.now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, ta := range s.tasks {
		if len(s.watchers[id]) > 0 {
			continue
		}
		if !ta.finishedAt.IsZero() && now.Sub(ta.finishedAt) > s.finishedRetention {
			delete(s.tasks, id)
		} else if now.Sub(ta.lastAt) > s.idleRetention {
			delete(s.tasks, id)
		}
	}
}

func (s *activityStore) taskCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.tasks)
}

// startActivityStore subscribes the store to activity events and starts its
// sweeper. Background goroutines stop with ctx.
func startActivityStore(ctx context.Context, store *activityStore, fleetPrefix string) {
	for _, p := range activityPrefixes(fleetPrefix) {
		subject := p + ".activity.>"
		tokenIdx := strings.Count(p, ".") + 2 // <prefix>.activity.<Knight>.<taskId>
		sub, err := nc.Subscribe(subject, func(msg *nats.Msg) {
			knight := ""
			if parts := strings.Split(msg.Subject, "."); len(parts) > tokenIdx {
				knight = parts[tokenIdx]
			}
			store.handleActivity(msg.Data, knight)
		})
		if err != nil {
			slog.Error("Activity: subscribe failed", "subject", subject, "error", err)
			continue
		}
		go func() { <-ctx.Done(); sub.Unsubscribe() }()
	}
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				store.sweep()
			}
		}
	}()
}

// ── Per-connection subscriptions ──

// activityClientCmd is the subscribe/unsubscribe part of a client message.
type activityClientCmd struct {
	Subscribe   string `json:"subscribe"`
	Unsubscribe string `json:"unsubscribe"`
	TaskID      string `json:"taskId"`
}

// activitySubscriptions tracks the tasks one WebSocket client watches.
type activitySubscriptions struct {
	store   *activityStore
	send    func(critical bool, data []byte)
	limit   int
	limiter *tokenBucket

	mu      sync.Mutex
	watched map[string]func()
}

func newActivitySubscriptions(store *activityStore, send func(critical bool, data []byte)) *activitySubscriptions {
	return &activitySubscriptions{
		store:   store,
		send:    send,
		limit:   activityMaxWatchedPerClient,
		limiter: newTokenBucket(activitySubscribeRate, activitySubscribeBurst, nil),
		watched: map[string]func(){},
	}
}

// handle applies a client message; it reports whether the message was an
// activity command.
func (a *activitySubscriptions) handle(raw []byte) bool {
	var cmd activityClientCmd
	if json.Unmarshal(raw, &cmd) != nil {
		return false
	}
	switch {
	case cmd.Subscribe == "activity":
		a.subscribe(cmd.TaskID)
	case cmd.Unsubscribe == "activity":
		a.unsubscribe(cmd.TaskID)
	default:
		return false
	}
	return true
}

func (a *activitySubscriptions) sendError(taskID, reason string) {
	if !validActivityTaskID(taskID) {
		taskID = ""
	}
	a.send(true, activityWSEvent(ActivityMsg{Op: activityOpError, TaskID: taskID, Error: reason}))
}

func (a *activitySubscriptions) subscribe(taskID string) {
	if !validActivityTaskID(taskID) {
		a.sendError(taskID, activityErrInvalidTaskID)
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.watched[taskID]; ok {
		return
	}
	if len(a.watched) >= a.limit {
		a.sendError(taskID, activityErrWatchLimit)
		return
	}
	if a.limiter != nil && !a.limiter.allow() {
		a.sendError(taskID, activityErrRateLimited)
		return
	}
	a.watched[taskID] = a.store.watch(taskID, func(m ActivityMsg) {
		// The backlog is what a viewer opened the task for: never drop it
		// silently. Live events are droppable; seq gaps reveal drops.
		a.send(m.Op == activityOpBacklog, activityWSEvent(m))
	})
}

func (a *activitySubscriptions) unsubscribe(taskID string) {
	a.mu.Lock()
	unwatch, ok := a.watched[taskID]
	delete(a.watched, taskID)
	a.mu.Unlock()
	if ok {
		unwatch()
	}
}

// closeAll drops every subscription of the client.
func (a *activitySubscriptions) closeAll() {
	a.mu.Lock()
	ws := a.watched
	a.watched = map[string]func(){}
	a.mu.Unlock()
	for _, unwatch := range ws {
		unwatch()
	}
}

func (a *activitySubscriptions) count() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.watched)
}

// activityWSEvent wraps an activity message as an `activity` WebSocket event.
func activityWSEvent(m ActivityMsg) []byte {
	payload, _ := json.Marshal(m)
	data, _ := json.Marshal(TaskEvent{
		Type:      "activity",
		Subject:   "activity",
		Data:      payload,
		Timestamp: time.Now().UTC(),
	})
	return data
}
