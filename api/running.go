package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nats-io/nats.go"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// In-flight task registry (#199, part of #183).
//
// Knights publish task activity events on core NATS
// (`<prefix>.activity.<Knight>.<taskId>`, contract roundtable-k8s/roundtable#249).
// The API keeps an in-memory, bounded, read-only view of every task that is
// running right now, keyed by taskId:
//
//   - task.started creates (or replaces, on redelivery) the entry;
//   - task.heartbeat refreshes it (counters, current tool);
//   - tool.started / tool.finished are kept as the entry's last tool event;
//   - task.finished removes it.
//
// An entry goes stale when no heartbeat arrives for 3x the heartbeat interval,
// and lost when its pod is gone or a JetStream MAX_DELIVERIES advisory names the
// task. On start the registry is rebuilt from every pod's introspection
// `inflight` list. Changes are pushed to WebSocket clients as `running` deltas.

const (
	activityVersion       = 1
	maxActivityEventBytes = 8 * 1024
	maxActivityPreview    = 500
	maxActivityArgs       = 200
	maxTaskIDLen          = 256

	runningStatusRunning = "running"
	runningStatusStale   = "stale"
	runningStatusLost    = "lost"

	lostReasonPodGone       = "pod_gone"
	lostReasonMaxDeliveries = "max_deliveries"

	defaultRunningMaxEntries    = 1000
	defaultHeartbeatInterval    = 10 * time.Second
	defaultLostRetention        = 10 * time.Minute
	defaultStaleRetention       = time.Hour
	defaultFinishedTombstoneTTL = 2 * time.Minute
)

// activityEvent mirrors the fields of roundtable pkg/nats.ActivityEvent the
// registry uses. Unknown fields are ignored (the contract is additive).
type activityEvent struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	Timestamp string `json:"ts"`
	Knight    string `json:"knight"`
	Pod       string `json:"pod"`
	Node      string `json:"node"`
	TaskID    string `json:"taskId"`
	RunID     string `json:"runId"`
	Chain     string `json:"chainName"`
	Step      string `json:"stepName"`
	Model     string `json:"model"`
	Seq       int64  `json:"seq"`
	Truncated bool   `json:"truncated"`

	Slot        *int   `json:"slot"`
	Concurrency *int   `json:"concurrency"`
	QueuedForMs *int64 `json:"queuedFor"`

	Turns        *int     `json:"turns"`
	InputTokens  *int64   `json:"inputTokens"`
	OutputTokens *int64   `json:"outputTokens"`
	CostUSD      *float64 `json:"costUsd"`
	CurrentTool  string   `json:"currentTool"`

	Tool          string `json:"tool"`
	ToolCallID    string `json:"toolCallId"`
	ArgsSummary   string `json:"argsSummary"`
	DurationMs    *int64 `json:"durationMs"`
	IsError       *bool  `json:"isError"`
	OutputPreview string `json:"outputPreview"`
}

// RunningToolEvent is the last tool event seen for a running task.
type RunningToolEvent struct {
	Type          string    `json:"type"` // tool.started | tool.finished
	Tool          string    `json:"tool"`
	ToolCallID    string    `json:"toolCallId,omitempty"`
	ArgsSummary   string    `json:"argsSummary,omitempty"`
	DurationMs    *int64    `json:"durationMs,omitempty"`
	IsError       *bool     `json:"isError,omitempty"`
	OutputPreview string    `json:"outputPreview,omitempty"`
	At            time.Time `json:"ts"`
}

// RunningTask is one in-flight task as served by GET /api/running.
type RunningTask struct {
	TaskID string `json:"taskId"`
	Knight string `json:"knight"`
	// Table is the knight's RoundTable, "none" when unknown (#273). Filled
	// when served, not stored in the registry.
	Table       string `json:"table"`
	Pod         string `json:"pod,omitempty"`
	Node        string `json:"node,omitempty"`
	RunID       string `json:"runId,omitempty"`
	ChainName   string `json:"chainName,omitempty"`
	StepName    string `json:"stepName,omitempty"`
	Model       string `json:"model,omitempty"`
	Slot        *int   `json:"slot,omitempty"`
	Concurrency *int   `json:"concurrency,omitempty"`
	QueuedForMs *int64 `json:"queuedForMs,omitempty"`

	// Status is running, stale or lost. LostReason is pod_gone or
	// max_deliveries when Status is lost.
	Status     string `json:"status"`
	LostReason string `json:"reason,omitempty"`

	StartedAt       time.Time  `json:"startedAt"`
	LastHeartbeatAt *time.Time `json:"lastHeartbeat,omitempty"`
	LastEventAt     time.Time  `json:"lastEventAt"`
	Seq             int64      `json:"seq"`

	Turns        *int     `json:"turns,omitempty"`
	InputTokens  *int64   `json:"inputTokens,omitempty"`
	OutputTokens *int64   `json:"outputTokens,omitempty"`
	CostUSD      *float64 `json:"costUsd,omitempty"`
	CurrentTool  string   `json:"currentTool,omitempty"`

	LastTool *RunningToolEvent `json:"lastTool,omitempty"`
	// Source is "activity" (built from events) or "introspect" (bootstrapped
	// from a pod's inflight list and not yet confirmed by an event).
	Source string `json:"source"`

	// aliveAt is the local receipt time of the last task.started/heartbeat
	// (or the bootstrap); stale detection uses it so knight clock skew does
	// not matter.
	aliveAt time.Time
}

// RunningDelta is the payload of a `running` WebSocket event.
type RunningDelta struct {
	Op     string        `json:"op"` // snapshot | upsert | remove
	Task   *RunningTask  `json:"task,omitempty"`
	TaskID string        `json:"taskId,omitempty"`
	Reason string        `json:"reason,omitempty"` // remove: finished | evicted | expired
	Tasks  []RunningTask `json:"tasks,omitempty"`
}

// runningRegistry is the in-memory in-flight task registry. It is safe for
// concurrent use. Subscriber callbacks run while the registry lock is held so
// deltas reach every client in order; they must not block or call back into
// the registry.
type runningRegistry struct {
	mu       sync.Mutex
	tasks    map[string]*RunningTask
	finished map[string]time.Time // tombstones: ignore late events of finished tasks
	subs     map[int]func(RunningDelta)
	nextSub  int

	maxEntries        int
	heartbeatInterval time.Duration
	lostRetention     time.Duration
	staleRetention    time.Duration
	tombstoneTTL      time.Duration
	now               func() time.Time
}

func newRunningRegistry(maxEntries int, heartbeatInterval time.Duration) *runningRegistry {
	if maxEntries < 1 {
		maxEntries = defaultRunningMaxEntries
	}
	if heartbeatInterval <= 0 {
		heartbeatInterval = defaultHeartbeatInterval
	}
	return &runningRegistry{
		tasks:             map[string]*RunningTask{},
		finished:          map[string]time.Time{},
		subs:              map[int]func(RunningDelta){},
		maxEntries:        maxEntries,
		heartbeatInterval: heartbeatInterval,
		lostRetention:     defaultLostRetention,
		staleRetention:    defaultStaleRetention,
		tombstoneTTL:      defaultFinishedTombstoneTTL,
		now:               time.Now,
	}
}

// staleAfter is how long an entry may go without a heartbeat before it is stale.
func (r *runningRegistry) staleAfter() time.Duration { return 3 * r.heartbeatInterval }

// subscribe registers fn for deltas and returns an unsubscribe func. The
// current snapshot is delivered first, atomically with the registration.
func (r *runningRegistry) subscribe(fn func(RunningDelta)) func() {
	r.mu.Lock()
	defer r.mu.Unlock()
	id := r.nextSub
	r.nextSub++
	r.subs[id] = fn
	fn(RunningDelta{Op: "snapshot", Tasks: r.snapshotLocked()})
	return func() {
		r.mu.Lock()
		delete(r.subs, id)
		r.mu.Unlock()
	}
}

func (r *runningRegistry) emitLocked(d RunningDelta) {
	for _, fn := range r.subs {
		fn(d)
	}
}

func (r *runningRegistry) emitUpsertLocked(t *RunningTask) {
	c := *t
	r.emitLocked(RunningDelta{Op: "upsert", Task: &c})
}

func (r *runningRegistry) removeLocked(taskID, reason string) {
	if _, ok := r.tasks[taskID]; !ok {
		return
	}
	delete(r.tasks, taskID)
	r.emitLocked(RunningDelta{Op: "remove", TaskID: taskID, Reason: reason})
}

// snapshot returns every entry, oldest first.
func (r *runningRegistry) snapshot() []RunningTask {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.snapshotLocked()
}

func (r *runningRegistry) snapshotLocked() []RunningTask {
	out := make([]RunningTask, 0, len(r.tasks))
	for _, t := range r.tasks {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].StartedAt.Equal(out[j].StartedAt) {
			return out[i].StartedAt.Before(out[j].StartedAt)
		}
		return out[i].TaskID < out[j].TaskID
	})
	return out
}

func (r *runningRegistry) get(taskID string) (RunningTask, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tasks[taskID]
	if !ok {
		return RunningTask{}, false
	}
	return *t, true
}

// bound cuts s to max runes.
func bound(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max])
}

// handleActivity applies one raw activity message. subjectKnight is the
// <Knight> token of the subject, used when the payload lacks a knight.
func (r *runningRegistry) handleActivity(data []byte, subjectKnight string) {
	if ev, ok := parseActivityEvent(data, subjectKnight); ok {
		r.apply(ev)
	}
}

// parseActivityEvent decodes and validates one raw activity message.
// subjectKnight fills in a missing knight.
func parseActivityEvent(data []byte, subjectKnight string) (activityEvent, bool) {
	var ev activityEvent
	if len(data) > maxActivityEventBytes {
		return ev, false
	}
	if err := json.Unmarshal(data, &ev); err != nil {
		return ev, false
	}
	if ev.V > activityVersion {
		return ev, false // a major we do not know
	}
	if ev.Knight == "" {
		ev.Knight = subjectKnight
	}
	return ev, true
}

func (r *runningRegistry) apply(ev activityEvent) {
	if ev.TaskID == "" || len(ev.TaskID) > maxTaskIDLen {
		return
	}
	now := r.now()
	at := now
	if ts, err := time.Parse(time.RFC3339Nano, ev.Timestamp); err == nil {
		at = ts.UTC()
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	switch ev.Type {
	case "task.finished":
		r.finished[ev.TaskID] = now
		r.removeLocked(ev.TaskID, "finished")
		return
	case "task.started":
		// A start is authoritative: a redelivered task starts over, possibly
		// on another pod, so replace any previous entry.
		delete(r.finished, ev.TaskID)
		if old, ok := r.tasks[ev.TaskID]; ok && old.Pod == ev.Pod && ev.Seq > 0 && ev.Seq < old.Seq {
			// Reordered: later events of this same run arrived first. Keep
			// their state and only add what the start carries.
			old.Slot, old.Concurrency, old.QueuedForMs = ev.Slot, ev.Concurrency, ev.QueuedForMs
			old.StartedAt = at
			r.fillCommon(old, ev)
			r.emitUpsertLocked(old)
			return
		}
		t := &RunningTask{TaskID: ev.TaskID, StartedAt: at, Source: "activity"}
		r.fillCommon(t, ev)
		t.Slot, t.Concurrency, t.QueuedForMs = ev.Slot, ev.Concurrency, ev.QueuedForMs
		t.Status = runningStatusRunning
		t.Seq = ev.Seq
		t.LastEventAt = at
		t.aliveAt = now
		r.insertLocked(t)
		r.emitUpsertLocked(t)
		return
	case "task.heartbeat", "tool.started", "tool.finished", "assistant.message":
	default:
		return
	}

	if _, done := r.finished[ev.TaskID]; done {
		return // late or reordered event of a finished task
	}
	t, ok := r.tasks[ev.TaskID]
	if !ok {
		// Missed task.started (event loss, or the API started mid-task and the
		// pod did not answer introspection): build the entry from this event.
		t = &RunningTask{TaskID: ev.TaskID, StartedAt: at, Status: runningStatusRunning, Source: "activity", aliveAt: now}
		r.fillCommon(t, ev)
		r.insertLocked(t)
	} else if ev.Seq > 0 && ev.Seq <= t.Seq {
		return // reordered: an older event than one already applied
	}
	if ev.Seq > t.Seq {
		t.Seq = ev.Seq
	}
	t.Source = "activity"
	r.fillCommon(t, ev)
	if at.After(t.LastEventAt) {
		t.LastEventAt = at
	}

	switch ev.Type {
	case "task.heartbeat":
		hb := at
		t.LastHeartbeatAt = &hb
		t.aliveAt = now
		if ev.Turns != nil {
			t.Turns = ev.Turns
		}
		if ev.InputTokens != nil {
			t.InputTokens = ev.InputTokens
		}
		if ev.OutputTokens != nil {
			t.OutputTokens = ev.OutputTokens
		}
		if ev.CostUSD != nil {
			t.CostUSD = ev.CostUSD
		}
		t.CurrentTool = bound(ev.CurrentTool, maxActivityArgs)
		if t.Status == runningStatusStale {
			t.Status = runningStatusRunning
		}
	case "tool.started", "tool.finished":
		t.LastTool = &RunningToolEvent{
			Type:          ev.Type,
			Tool:          bound(ev.Tool, maxActivityArgs),
			ToolCallID:    bound(ev.ToolCallID, maxActivityArgs),
			ArgsSummary:   bound(ev.ArgsSummary, maxActivityArgs),
			DurationMs:    ev.DurationMs,
			IsError:       ev.IsError,
			OutputPreview: bound(ev.OutputPreview, maxActivityPreview),
			At:            at,
		}
		if ev.Type == "tool.started" {
			t.CurrentTool = t.LastTool.Tool
		} else if t.CurrentTool == t.LastTool.Tool {
			t.CurrentTool = ""
		}
	case "assistant.message":
		// Only the counters above change; the preview belongs to the live
		// activity stream (#184), not the registry.
	}
	r.emitUpsertLocked(t)
}

// fillCommon copies the identity fields of ev into t, keeping known values
// when the event omits them.
func (r *runningRegistry) fillCommon(t *RunningTask, ev activityEvent) {
	set := func(dst *string, v string) {
		if v != "" {
			*dst = bound(v, maxActivityArgs)
		}
	}
	set(&t.Knight, ev.Knight)
	set(&t.Pod, ev.Pod)
	set(&t.Node, ev.Node)
	set(&t.RunID, ev.RunID)
	set(&t.ChainName, ev.Chain)
	set(&t.StepName, ev.Step)
	set(&t.Model, ev.Model)
}

// insertLocked adds t, evicting one entry when the registry is full: lost
// entries first, then stale, then the one with the oldest event.
func (r *runningRegistry) insertLocked(t *RunningTask) {
	if _, exists := r.tasks[t.TaskID]; !exists && len(r.tasks) >= r.maxEntries {
		rank := map[string]int{runningStatusLost: 0, runningStatusStale: 1, runningStatusRunning: 2}
		var victim *RunningTask
		for _, c := range r.tasks {
			if victim == nil || rank[c.Status] < rank[victim.Status] ||
				(rank[c.Status] == rank[victim.Status] && c.LastEventAt.Before(victim.LastEventAt)) {
				victim = c
			}
		}
		if victim != nil {
			r.removeLocked(victim.TaskID, "evicted")
		}
	}
	r.tasks[t.TaskID] = t
}

// sweep marks entries stale after 3 missed heartbeats and drops entries that
// have been lost or stale for longer than their retention.
func (r *runningRegistry) sweep() {
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, t := range r.tasks {
		idle := now.Sub(t.aliveAt)
		switch t.Status {
		case runningStatusRunning:
			if idle > r.staleAfter() {
				t.Status = runningStatusStale
				r.emitUpsertLocked(t)
			}
		case runningStatusStale:
			if idle > r.staleRetention {
				r.removeLocked(id, "expired")
			}
		case runningStatusLost:
			if idle > r.lostRetention {
				r.removeLocked(id, "expired")
			}
		}
	}
	for id, at := range r.finished {
		if now.Sub(at) > r.tombstoneTTL {
			delete(r.finished, id)
		}
	}
}

// markLostLocked marks t lost. Lost is terminal: only task.started (a
// redelivery) or task.finished replaces it.
func (r *runningRegistry) markLostLocked(t *RunningTask, reason string) {
	if t.Status == runningStatusLost {
		return
	}
	t.Status = runningStatusLost
	t.LostReason = reason
	// Retention of lost entries counts from now.
	t.aliveAt = r.now()
	r.emitUpsertLocked(t)
}

// markLost marks a task lost (e.g. a MAX_DELIVERIES advisory named it).
func (r *runningRegistry) markLost(taskID, reason string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tasks[taskID]
	if !ok {
		return false
	}
	r.markLostLocked(t, reason)
	return true
}

// reconcilePods marks every entry whose pod is not in livePods as lost.
func (r *runningRegistry) reconcilePods(livePods map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, t := range r.tasks {
		if t.Pod != "" && !livePods[t.Pod] {
			r.markLostLocked(t, lostReasonPodGone)
		}
	}
}

// inflightTask is one element of a pod's introspection `stats.inflight` list
// (pi-knight and claude-knight).
type inflightTask struct {
	TaskID          string  `json:"taskId"`
	RunID           string  `json:"runId"`
	ChainName       string  `json:"chainName"`
	StepName        string  `json:"stepName"`
	Model           string  `json:"model"`
	StartedAt       string  `json:"startedAt"`
	LastHeartbeatAt *string `json:"lastHeartbeatAt"`
}

// bootstrap adds a pod's in-flight tasks. Entries already known from activity
// events (or finished meanwhile) win.
func (r *runningRegistry) bootstrap(knight, pod, node string, inflight []inflightTask) int {
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	added := 0
	for _, it := range inflight {
		if it.TaskID == "" || len(it.TaskID) > maxTaskIDLen {
			continue
		}
		if _, ok := r.tasks[it.TaskID]; ok {
			continue
		}
		if _, done := r.finished[it.TaskID]; done {
			continue
		}
		t := &RunningTask{TaskID: it.TaskID, Status: runningStatusRunning, Source: "introspect", aliveAt: now}
		r.fillCommon(t, activityEvent{Knight: knight, Pod: pod, Node: node, RunID: it.RunID, Chain: it.ChainName, Step: it.StepName, Model: it.Model})
		t.StartedAt = now
		if ts, err := time.Parse(time.RFC3339Nano, it.StartedAt); err == nil {
			t.StartedAt = ts.UTC()
		}
		t.LastEventAt = t.StartedAt
		if it.LastHeartbeatAt != nil {
			if ts, err := time.Parse(time.RFC3339Nano, *it.LastHeartbeatAt); err == nil {
				hb := ts.UTC()
				t.LastHeartbeatAt = &hb
				t.LastEventAt = hb
			}
		}
		r.insertLocked(t)
		r.emitUpsertLocked(t)
		added++
	}
	return added
}

// ── Wiring: NATS, Kubernetes, HTTP ──

// introspectRequester sends a NATS request and returns the reply payload.
type introspectRequester func(subject string, data []byte, timeout time.Duration) ([]byte, error)

// knightPodRef is one running knight pod to ask for its in-flight tasks.
type knightPodRef struct {
	Knight string // Knight CR name (lowercase)
	Pod    string
	Node   string
	Prefix string // NATS prefix of the knight's table
}

// listKnightPods returns the knight pods (not CronJob pods) of the namespace
// and the set of pod names that still exist. prefixFor maps a Knight CR name
// to its NATS prefix.
func listKnightPods(ctx context.Context, namespace string, prefixFor map[string]string, defaultPrefix string) ([]knightPodRef, map[string]bool, error) {
	if k8sClient == nil {
		return nil, nil, fmt.Errorf("kubernetes client not available")
	}
	pods, err := k8sClient.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/name=knight",
	})
	if err != nil {
		return nil, nil, err
	}
	live := map[string]bool{}
	var refs []knightPodRef
	for _, pod := range pods.Items {
		if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
			continue
		}
		live[pod.Name] = true
		if _, ok := pod.Labels["job-name"]; ok {
			continue
		}
		knight := pod.Labels["app.kubernetes.io/instance"]
		if knight == "" || pod.Status.Phase != corev1.PodRunning {
			continue
		}
		prefix := defaultPrefix
		if p, ok := prefixFor[knight]; ok && p != "" {
			prefix = p
		}
		refs = append(refs, knightPodRef{Knight: knight, Pod: pod.Name, Node: pod.Spec.NodeName, Prefix: prefix})
	}
	return refs, live, nil
}

// knightPrefixes maps Knight CR name to its NATS prefix (from spec.nats.subjects).
func knightPrefixes(ctx context.Context, namespace string) map[string]string {
	out := map[string]string{}
	if dynClient == nil {
		return out
	}
	list, err := dynClient.Resource(knightGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		slog.Warn("Running: knight CR list failed", "error", err)
		return out
	}
	for i := range list.Items {
		if p, err := deriveIntrospectPrefix(&list.Items[i]); err == nil {
			out[list.Items[i].GetName()] = p
		}
	}
	return out
}

// bootstrapRunning rebuilds the registry from every knight pod's per-pod
// introspection reply (`<prefix>.introspect.<Knight>.<pod>`, type=stats).
// Only pods on a prefix the registry subscribes to are asked: tasks of other
// tables would never receive task.finished and linger as stale.
func bootstrapRunning(ctx context.Context, reg *runningRegistry, namespace string, prefixes []string, req introspectRequester, timeout time.Duration) int {
	if len(prefixes) == 0 {
		return 0
	}
	subscribed := map[string]bool{}
	for _, p := range prefixes {
		subscribed[p] = true
	}
	refs, _, err := listKnightPods(ctx, namespace, knightPrefixes(ctx, namespace), prefixes[0])
	if err != nil {
		slog.Warn("Running: bootstrap pod list failed", "error", err)
		return 0
	}
	payload, _ := json.Marshal(map[string]string{"type": "stats"})
	var wg sync.WaitGroup
	var mu sync.Mutex
	total := 0
	sem := make(chan struct{}, 16)
	for _, ref := range refs {
		if !subscribed[ref.Prefix] || !validKnightName.MatchString(ref.Knight) || !validPodName(ref.Pod) {
			continue
		}
		wg.Add(1)
		go func(ref knightPodRef) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			subject := fmt.Sprintf("%s.introspect.%s.%s", ref.Prefix, capitalizeKnight(ref.Knight), ref.Pod)
			data, err := req(subject, payload, timeout)
			if err != nil {
				slog.Debug("Running: introspect failed", "subject", subject, "error", err)
				return
			}
			var reply struct {
				Pod      string         `json:"pod"`
				Node     string         `json:"node"`
				Inflight []inflightTask `json:"inflight"`
			}
			if err := json.Unmarshal(data, &reply); err != nil {
				return
			}
			pod, node := ref.Pod, ref.Node
			if reply.Pod != "" {
				pod = reply.Pod
			}
			if reply.Node != "" {
				node = reply.Node
			}
			n := reg.bootstrap(capitalizeKnight(ref.Knight), pod, node, reply.Inflight)
			mu.Lock()
			total += n
			mu.Unlock()
		}(ref)
	}
	wg.Wait()
	return total
}

// validPodName accepts DNS-1123 pod names (no NATS wildcards or separators).
func validPodName(s string) bool {
	if s == "" || len(s) > 253 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// maxDeliveriesAdvisory is the JetStream MAX_DELIVERIES advisory payload
// (`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.<stream>.<consumer>`).
type maxDeliveriesAdvisory struct {
	Stream    string `json:"stream"`
	Consumer  string `json:"consumer"`
	StreamSeq uint64 `json:"stream_seq"`
}

// taskIDFromTaskMessage extracts the task id from a task message
// (`<prefix>.tasks.<domain>.<taskId>`), preferring the payload's task_id.
func taskIDFromTaskMessage(subject string, data []byte) string {
	var p struct {
		TaskID  string `json:"task_id"`
		TaskID2 string `json:"taskId"`
	}
	if json.Unmarshal(data, &p) == nil {
		if p.TaskID != "" {
			return p.TaskID
		}
		if p.TaskID2 != "" {
			return p.TaskID2
		}
	}
	if i := strings.Index(subject, ".tasks."); i >= 0 {
		parts := strings.Split(subject[i+len(".tasks."):], ".")
		if len(parts) >= 2 {
			return parts[len(parts)-1]
		}
	}
	return ""
}

// handleMaxDeliveries resolves an advisory to its task (fetch is
// stream+seq -> subject, payload) and marks the task lost.
func (r *runningRegistry) handleMaxDeliveries(data []byte, fetch func(stream string, seq uint64) (string, []byte, error)) {
	var adv maxDeliveriesAdvisory
	if err := json.Unmarshal(data, &adv); err != nil || adv.Stream == "" || adv.StreamSeq == 0 {
		return
	}
	subject, payload, err := fetch(adv.Stream, adv.StreamSeq)
	if err != nil {
		slog.Debug("Running: advisory message lookup failed", "stream", adv.Stream, "seq", adv.StreamSeq, "error", err)
		return
	}
	if id := taskIDFromTaskMessage(subject, payload); id != "" {
		if r.markLost(id, lostReasonMaxDeliveries) {
			slog.Info("Running: task lost after max deliveries", "taskId", id, "stream", adv.Stream)
		}
	}
}

// runningHeartbeatInterval is the knights' heartbeat interval
// (ACTIVITY_HEARTBEAT_INTERVAL, a Go duration; default 10s as in pi-knight and
// claude-knight). Entries go stale after 3x this.
func runningHeartbeatInterval() time.Duration {
	if d, err := time.ParseDuration(envOr("ACTIVITY_HEARTBEAT_INTERVAL", "")); err == nil && d > 0 {
		return d
	}
	return defaultHeartbeatInterval
}

// activityPrefixes returns the NATS prefixes whose activity is tracked:
// ACTIVITY_PREFIXES (comma separated) or the prefixes of every table (#239).
func activityPrefixes(tablePrefixes []string) []string {
	var out []string
	for _, p := range strings.Split(envOr("ACTIVITY_PREFIXES", strings.Join(tablePrefixes, ",")), ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// activityResyncInterval is how often the set of tables is re-read to follow
// RoundTables created or removed after startup (#291).
const activityResyncInterval = 30 * time.Second

// activityFollower keeps one `<prefix>.activity.>` subscription per prefix,
// idempotently: sync subscribes prefixes it does not have yet and
// unsubscribes those that disappeared.
type activityFollower struct {
	conn *nats.Conn
	reg  *runningRegistry
	act  *activityStore

	mu   sync.Mutex
	subs map[string]*nats.Subscription
}

func newActivityFollower(conn *nats.Conn, reg *runningRegistry, act *activityStore) *activityFollower {
	return &activityFollower{conn: conn, reg: reg, act: act, subs: map[string]*nats.Subscription{}}
}

// sync makes the subscribed set equal prefixes and returns the prefixes newly
// subscribed. A failed subscribe is retried on the next call.
func (f *activityFollower) sync(prefixes []string) []string {
	want := map[string]bool{}
	for _, p := range prefixes {
		want[p] = true
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for p, sub := range f.subs {
		if !want[p] {
			_ = sub.Unsubscribe()
			delete(f.subs, p)
			slog.Info("Running: activity unsubscribed", "prefix", p)
		}
	}
	var added []string
	for _, p := range prefixes {
		if _, ok := f.subs[p]; ok {
			continue
		}
		sub, err := f.subscribe(p)
		if err != nil {
			slog.Error("Running: activity subscribe failed", "prefix", p, "error", err)
			continue
		}
		f.subs[p] = sub
		added = append(added, p)
	}
	return added
}

func (f *activityFollower) subscribe(p string) (*nats.Subscription, error) {
	tokenIdx := strings.Count(p, ".") + 2 // <prefix>.activity.<Knight>.<taskId>
	return f.conn.Subscribe(p+".activity.>", func(msg *nats.Msg) {
		knight := ""
		if parts := strings.Split(msg.Subject, "."); len(parts) > tokenIdx {
			knight = parts[tokenIdx]
		}
		ev, ok := parseActivityEvent(msg.Data, knight)
		if !ok {
			return
		}
		f.reg.apply(ev)
		if f.act != nil {
			f.act.add(ev, msg.Data)
		}
	})
}

// startRunningRegistry subscribes the registry to activity events and JetStream
// MAX_DELIVERIES advisories, bootstraps it from pod introspection and starts
// the stale sweeper and pod reconciler. Background goroutines stop with ctx.
// When act is non-nil the same activity events also feed the per-task
// activity buffers (#184) and are swept on the same ticker.
func startRunningRegistry(ctx context.Context, reg *runningRegistry, act *activityStore, listPrefixes func(context.Context) []string, namespace string) {
	follower := newActivityFollower(nc, reg, act)
	bootstrap := func(prefixes []string) {
		if len(prefixes) == 0 {
			return
		}
		req := func(subject string, data []byte, timeout time.Duration) ([]byte, error) {
			m, err := nc.Request(subject, data, timeout)
			if err != nil {
				return nil, err
			}
			return m.Data, nil
		}
		bctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		n := bootstrapRunning(bctx, reg, namespace, prefixes, req, 3*time.Second)
		slog.Info("Running: registry bootstrapped from introspection", "prefixes", prefixes, "tasks", n)
	}
	// Subscribe first, bootstrap after, so no event between the two is missed;
	// entries already seen live win over the introspected ones.
	initial := follower.sync(activityPrefixes(listPrefixes(ctx)))
	go bootstrap(initial)

	go func() {
		t := time.NewTicker(activityResyncInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				// Only newly added prefixes are bootstrapped.
				added := follower.sync(activityPrefixes(listPrefixes(ctx)))
				if len(added) > 0 {
					go bootstrap(added)
				}
			}
		}
	}()

	if _, err := nc.Subscribe("$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.>", func(msg *nats.Msg) {
		reg.handleMaxDeliveries(msg.Data, jsFetchMessage)
	}); err != nil {
		slog.Warn("Running: MAX_DELIVERIES advisory subscribe failed", "error", err)
	}

	go func() {
		sweep := time.NewTicker(2 * time.Second)
		pods := time.NewTicker(15 * time.Second)
		defer sweep.Stop()
		defer pods.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-sweep.C:
				reg.sweep()
				if act != nil {
					act.sweep()
				}
			case <-pods.C:
				if k8sClient == nil {
					continue
				}
				lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				_, live, err := listKnightPods(lctx, namespace, nil, "")
				cancel()
				if err != nil {
					slog.Warn("Running: pod list failed", "error", err)
					continue
				}
				reg.reconcilePods(live)
			}
		}
	}()
}

// jsFetchMessage reads one message of a JetStream stream by sequence.
func jsFetchMessage(stream string, seq uint64) (string, []byte, error) {
	if js == nil {
		return "", nil, fmt.Errorf("jetstream not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := js.Stream(ctx, stream)
	if err != nil {
		return "", nil, err
	}
	m, err := s.GetMsg(ctx, seq)
	if err != nil {
		return "", nil, err
	}
	return m.Subject, m.Data, nil
}

// runningResponse is the body of GET /api/running.
type runningResponse struct {
	Tasks               []RunningTask `json:"tasks"`
	Count               int           `json:"count"`
	GeneratedAt         time.Time     `json:"generatedAt"`
	HeartbeatIntervalMs int64         `json:"heartbeatIntervalMs"`
	StaleAfterMs        int64         `json:"staleAfterMs"`
}

func runningHandler(reg *runningRegistry, namespace string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tables := knightTables(r.Context(), namespace)
		filter := tableFilter(r)
		all := reg.snapshot()
		tasks := make([]RunningTask, 0, len(all))
		for _, t := range all {
			t.Table = tableOrNone(tables[strings.ToLower(t.Knight)])
			if tableMatches(filter, t.Table) {
				tasks = append(tasks, t)
			}
		}
		body, err := json.Marshal(runningResponse{
			Tasks:               tasks,
			Count:               len(tasks),
			GeneratedAt:         reg.now().UTC(),
			HeartbeatIntervalMs: reg.heartbeatInterval.Milliseconds(),
			StaleAfterMs:        reg.staleAfter().Milliseconds(),
		})
		if err != nil {
			jsonError(w, "encode error", http.StatusInternalServerError)
			return
		}
		writeRedactedJSON(w, body)
	}
}

// withTables returns a copy of d whose tasks carry their knight's table
// ("none" when unknown), as GET /api/running does, so live updates match the
// snapshot when the browser filters by table.
func withTables(d RunningDelta, tables map[string]string) RunningDelta {
	fill := func(t RunningTask) RunningTask {
		t.Table = tableOrNone(tables[strings.ToLower(t.Knight)])
		return t
	}
	if d.Task != nil {
		t := fill(*d.Task)
		d.Task = &t
	}
	if d.Tasks != nil {
		ts := make([]RunningTask, len(d.Tasks))
		for i, t := range d.Tasks {
			ts[i] = fill(t)
		}
		d.Tasks = ts
	}
	return d
}

// runningWSEvent wraps a delta as a `running` WebSocket event.
func runningWSEvent(d RunningDelta) []byte {
	payload, _ := json.Marshal(d)
	data, _ := json.Marshal(TaskEvent{
		Type:      "running",
		Subject:   "running",
		Data:      payload,
		Timestamp: time.Now().UTC(),
	})
	return data
}

// knightTables maps the lowercased Knight CR name (the registry reports the
// capitalised name) to its RoundTable. Best effort: empty on
// error.
func knightTables(ctx context.Context, namespace string) map[string]string {
	out := map[string]string{}
	if dynClient == nil {
		return out
	}
	list, err := dynClient.Resource(knightGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return out
	}
	for i := range list.Items {
		out[strings.ToLower(list.Items[i].GetName())] = knightTableName(&list.Items[i])
	}
	return out
}

// tableCache holds the knight-to-table map so hot paths (the running registry
// callback, which runs under its lock) only read a cached copy; lookups are
// time-limited and happen outside any lock.
type tableCache struct {
	mu       sync.RWMutex
	tables   map[string]string
	lookup   func(ctx context.Context) map[string]string
	interval time.Duration
	timeout  time.Duration
}

func newTableCache(lookup func(ctx context.Context) map[string]string, interval, timeout time.Duration) *tableCache {
	return &tableCache{lookup: lookup, interval: interval, timeout: timeout}
}

// get returns the cached map (nil before the first successful refresh).
func (c *tableCache) get() map[string]string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.tables
}

// refresh does one time-limited lookup; an empty result keeps the old copy.
func (c *tableCache) refresh() {
	ctx, cancel := context.WithTimeout(context.Background(), c.timeout)
	defer cancel()
	m := c.lookup(ctx)
	if len(m) == 0 {
		return
	}
	c.mu.Lock()
	c.tables = m
	c.mu.Unlock()
}

// run refreshes periodically until done closes.
func (c *tableCache) run(done <-chan struct{}) {
	t := time.NewTicker(c.interval)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			c.refresh()
		}
	}
}
