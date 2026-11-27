package main

import (
	"sort"
	"strconv"
	"time"
)

// Chain DTO extensions (#227, part of #187): forEach fan-out items, bounded
// loop rounds and when-skips, plus a join of every running task with the
// in-flight registry (#183) so the UI can show its pod, elapsed time and
// heartbeat age. All fields are additive; existing StepSummary/ChainSummary
// fields keep their names and meaning.

// Step skip reasons set by the operator in status.stepStatuses[].reason.
const (
	stepReasonWhenFalse   = "WhenFalse"
	stepReasonChainFailed = "ChainFailed"
)

// ChainTaskInFlight is the in-flight registry view of a running chain task.
type ChainTaskInFlight struct {
	Knight string `json:"knight,omitempty"`
	Pod    string `json:"pod,omitempty"`
	Node   string `json:"node,omitempty"`
	// Status is the registry status: running, stale or lost.
	Status     string `json:"status"`
	LostReason string `json:"reason,omitempty"`
	StartedAt  string `json:"startedAt"`
	// ElapsedMs is the time since the knight started the task.
	ElapsedMs int64 `json:"elapsedMs"`
	// LastHeartbeat / HeartbeatAgeMs are unset until the first heartbeat.
	LastHeartbeat  *string `json:"lastHeartbeat,omitempty"`
	HeartbeatAgeMs *int64  `json:"heartbeatAgeMs,omitempty"`
	CurrentTool    string  `json:"currentTool,omitempty"`
}

// ChainItemSummary is one forEach item of a fan-out step.
type ChainItemSummary struct {
	Index  int    `json:"index"`
	Phase  string `json:"phase"`
	RunID  string `json:"runId,omitempty"`
	TaskID string `json:"taskId,omitempty"`
	Error  string `json:"error,omitempty"`
	// OutputBytes is the size of the item output kept in the Chain status
	// (the operator truncates it; the full output is in the chain-outputs KV).
	OutputBytes    int                `json:"outputBytes"`
	Retries        int                `json:"retries,omitempty"`
	StartTime      *string            `json:"startTime,omitempty"`
	CompletionTime *string            `json:"completionTime,omitempty"`
	InFlight       *ChainTaskInFlight `json:"inFlight,omitempty"`
}

// ChainFanOutSummary is the per-item state of a forEach step.
type ChainFanOutSummary struct {
	Total     int `json:"total"`
	Pending   int `json:"pending"`
	Running   int `json:"running"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
	Skipped   int `json:"skipped"`
	// ItemPhases holds one character per item, in list order:
	// P=Pending, R=Running, S=Succeeded, F=Failed, K=Skipped.
	ItemPhases string `json:"itemPhases,omitempty"`
	// Items are the detailed entries the operator keeps (every in-flight item
	// and a bounded set of finished ones); OmittedItems counts the rest.
	Items        []ChainItemSummary `json:"items"`
	OmittedItems int                `json:"omittedItems"`
}

// ChainLoopStepSummary is one loop body step in the round it last ran in.
type ChainLoopStepSummary struct {
	Name        string `json:"name"`
	Knight      string `json:"knight,omitempty"`
	Iteration   int    `json:"iteration"`
	Phase       string `json:"phase"`
	TaskID      string `json:"taskId,omitempty"`
	Error       string `json:"error,omitempty"`
	OutputBytes int    `json:"outputBytes"`
	// OutputSummary is the operator's truncated (1 KiB) output of a finished
	// run from status.loop.history; empty for the live entry of a body step.
	OutputSummary  string             `json:"outputSummary,omitempty"`
	Retries        int                `json:"retries,omitempty"`
	StartTime      *string            `json:"startTime,omitempty"`
	CompletionTime *string            `json:"completionTime,omitempty"`
	InFlight       *ChainTaskInFlight `json:"inFlight,omitempty"`
}

// ChainLoopRound groups the body step runs of one round. Rounds come from
// status.loop.history (finished runs of earlier rounds) merged with
// status.loop.steps (the latest run of each body step); without history
// (older operator) only the latter is listed.
type ChainLoopRound struct {
	Iteration int                    `json:"iteration"`
	Steps     []ChainLoopStepSummary `json:"steps"`
}

// ChainLoopSummary is the spec and status of a bounded loop step.
type ChainLoopSummary struct {
	// Iteration is the current (or last) round, 1-based; 0 before the first.
	Iteration int `json:"iteration"`
	// MaxIterations is the round cap of this run (status), falling back to
	// spec.loop.maxIterations before the loop starts.
	MaxIterations int `json:"maxIterations"`
	// OnExhausted is fail (default) or continue.
	OnExhausted string `json:"onExhausted"`
	// Outcome is Converged, Exhausted or Failed once the loop ended.
	Outcome string `json:"outcome,omitempty"`
	Until   string `json:"until,omitempty"`
	From    string `json:"from,omitempty"`
	// Body lists the body step names in run order.
	Body   []string         `json:"body"`
	Rounds []ChainLoopRound `json:"rounds"`
}

// applyStepSpecExtras copies the forEach/when/loop spec fields of a step.
func applyStepSpecExtras(step *StepSummary, ss map[string]interface{}) {
	if ss == nil {
		return
	}
	step.When = getStr(ss, "when")
	if getNestedMap(ss, "forEach") != nil {
		step.ForEach = true
		step.MaxParallel = getInt(ss, "maxParallel")
		step.FailurePolicy = getStr(ss, "failurePolicy")
		if step.FailurePolicy == "" {
			step.FailurePolicy = "failFast"
		}
	}
	if loop := getNestedMap(ss, "loop"); loop != nil {
		l := &ChainLoopSummary{
			MaxIterations: getInt(loop, "maxIterations"),
			OnExhausted:   getStr(loop, "onExhausted"),
			Until:         getStr(loop, "until"),
			From:          getStr(loop, "from"),
			Body:          []string{},
			Rounds:        []ChainLoopRound{},
		}
		if l.MaxIterations == 0 {
			l.MaxIterations = 3 // CRD default
		}
		if l.OnExhausted == "" {
			l.OnExhausted = "fail"
		}
		for _, b := range getSlice(loop, "steps") {
			if bm, ok := b.(map[string]interface{}); ok {
				l.Body = append(l.Body, getStr(bm, "name"))
			}
		}
		step.Loop = l
	}
}

// applyStepStatusExtras copies taskId, error, skip reason, fan-out and loop
// state from a status.stepStatuses[] entry. Must run after
// applyStepSpecExtras so status values override spec defaults.
func applyStepStatusExtras(step *StepSummary, sm, ss map[string]interface{}) {
	step.TaskID = getStr(sm, "taskId")
	step.Error = getStr(sm, "error")
	step.Reason = getStr(sm, "reason")
	if step.Phase == "Skipped" {
		step.Skipped = true
		step.SkipReason = step.Reason
		step.SkipMessage = skipMessage(step.Reason, step.When)
	}

	if fo := getNestedMap(sm, "fanOut"); fo != nil {
		step.ForEach = true
		f := &ChainFanOutSummary{
			Total:        getInt(fo, "total"),
			Pending:      getInt(fo, "pending"),
			Running:      getInt(fo, "running"),
			Succeeded:    getInt(fo, "succeeded"),
			Failed:       getInt(fo, "failed"),
			Skipped:      getInt(fo, "skipped"),
			ItemPhases:   getStr(fo, "itemPhases"),
			OmittedItems: getInt(fo, "omittedItems"),
			Items:        []ChainItemSummary{},
		}
		for _, it := range getSlice(fo, "items") {
			im, ok := it.(map[string]interface{})
			if !ok {
				continue
			}
			item := ChainItemSummary{
				Index:       getInt(im, "index"),
				Phase:       getStr(im, "phase"),
				RunID:       getStr(im, "runId"),
				TaskID:      getStr(im, "taskId"),
				Error:       getStr(im, "error"),
				OutputBytes: outputLen(im),
				Retries:     getInt(im, "retries"),
			}
			item.StartTime = optStr(getStr(im, "startedAt"))
			item.CompletionTime = optStr(getStr(im, "completedAt"))
			f.Items = append(f.Items, item)
		}
		sort.SliceStable(f.Items, func(i, j int) bool { return f.Items[i].Index < f.Items[j].Index })
		step.FanOut = f
	}

	if ls := getNestedMap(sm, "loop"); ls != nil {
		if step.Loop == nil {
			step.Loop = &ChainLoopSummary{OnExhausted: "fail", Body: []string{}, Rounds: []ChainLoopRound{}}
		}
		l := step.Loop
		l.Iteration = getInt(ls, "iteration")
		if m := getInt(ls, "maxIterations"); m > 0 {
			l.MaxIterations = m
		}
		l.Outcome = getStr(ls, "outcome")

		bodyKnight := map[string]string{}
		if loop := getNestedMap(ss, "loop"); loop != nil {
			for _, b := range getSlice(loop, "steps") {
				if bm, ok := b.(map[string]interface{}); ok {
					bodyKnight[getStr(bm, "name")] = getRefName(bm, "knightRef")
				}
			}
		}

		byRound := map[int]*ChainLoopRound{}
		add := func(bs ChainLoopStepSummary) {
			r, ok := byRound[bs.Iteration]
			if !ok {
				r = &ChainLoopRound{Iteration: bs.Iteration, Steps: []ChainLoopStepSummary{}}
				byRound[bs.Iteration] = r
			}
			r.Steps = append(r.Steps, bs)
		}
		live := map[[2]string]bool{}       // round/taskId of live entries
		liveByStep := map[[2]string]bool{} // round/step of live entries
		for _, b := range getSlice(ls, "steps") {
			bm, ok := b.(map[string]interface{})
			if !ok {
				continue
			}
			bs := ChainLoopStepSummary{
				Name:        getStr(bm, "name"),
				Iteration:   getInt(bm, "iteration"),
				Phase:       getStr(bm, "phase"),
				TaskID:      getStr(bm, "taskId"),
				Error:       getStr(bm, "error"),
				OutputBytes: outputLen(bm),
				Retries:     getInt(bm, "retries"),
			}
			bs.Knight = bodyKnight[bs.Name]
			bs.StartTime = optStr(getStr(bm, "startedAt"))
			bs.CompletionTime = optStr(getStr(bm, "completedAt"))
			live[[2]string{strconv.Itoa(bs.Iteration), bs.TaskID}] = true
			liveByStep[[2]string{strconv.Itoa(bs.Iteration), bs.Name}] = true
			add(bs)
		}
		// History: finished runs of earlier rounds. The live entry wins when
		// it is the same run (same round and taskId).
		for _, h := range getSlice(ls, "history") {
			hm, ok := h.(map[string]interface{})
			if !ok {
				continue
			}
			bs := ChainLoopStepSummary{
				Name:          getStr(hm, "step"),
				Iteration:     getInt(hm, "round"),
				Phase:         getStr(hm, "phase"),
				TaskID:        getStr(hm, "taskId"),
				Error:         getStr(hm, "error"),
				OutputSummary: getStr(hm, "outputSummary"),
				OutputBytes:   len(getStr(hm, "outputSummary")),
			}
			round := strconv.Itoa(bs.Iteration)
			if bs.TaskID != "" && live[[2]string{round, bs.TaskID}] {
				continue
			}
			// Without a taskId the run cannot be matched by id; a live entry
			// of the same step in the same round is the same run.
			if bs.TaskID == "" && liveByStep[[2]string{round, bs.Name}] {
				continue
			}
			bs.Knight = bodyKnight[bs.Name]
			bs.StartTime = optStr(getStr(hm, "startedAt"))
			bs.CompletionTime = optStr(getStr(hm, "finishedAt"))
			add(bs)
		}
		bodyIdx := map[string]int{}
		for i, n := range l.Body {
			bodyIdx[n] = i
		}
		l.Rounds = make([]ChainLoopRound, 0, len(byRound))
		for _, r := range byRound {
			sort.SliceStable(r.Steps, func(i, j int) bool {
				return bodyIdx[r.Steps[i].Name] < bodyIdx[r.Steps[j].Name]
			})
			l.Rounds = append(l.Rounds, *r)
		}
		sort.Slice(l.Rounds, func(i, j int) bool { return l.Rounds[i].Iteration < l.Rounds[j].Iteration })
	}
}

// skipMessage is a human-readable explanation of a skipped step.
func skipMessage(reason, when string) string {
	switch reason {
	case stepReasonWhenFalse:
		if when != "" {
			return "when evaluated to false: " + when
		}
		return "when evaluated to false"
	case stepReasonChainFailed:
		return "the chain failed before this step ran"
	case "":
		return ""
	default:
		return reason
	}
}

func optStr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// joinChainInFlight adds the in-flight registry view to every running step,
// forEach item and loop body step that carries a taskId. A nil registry is a
// no-op.
func joinChainInFlight(c *ChainSummary, reg *runningRegistry) {
	if reg == nil || c == nil {
		return
	}
	now := reg.now()
	lookup := func(phase, taskID string) *ChainTaskInFlight {
		if taskID == "" || phase != "Running" {
			return nil
		}
		t, ok := reg.get(taskID)
		if !ok {
			return nil
		}
		return inFlightView(t, now)
	}
	for i := range c.Steps {
		s := &c.Steps[i]
		s.InFlight = lookup(s.Phase, s.TaskID)
		if s.FanOut != nil {
			for j := range s.FanOut.Items {
				it := &s.FanOut.Items[j]
				it.InFlight = lookup(it.Phase, it.TaskID)
			}
		}
		if s.Loop != nil {
			for r := range s.Loop.Rounds {
				for j := range s.Loop.Rounds[r].Steps {
					bs := &s.Loop.Rounds[r].Steps[j]
					bs.InFlight = lookup(bs.Phase, bs.TaskID)
				}
			}
		}
	}
}

func inFlightView(t RunningTask, now time.Time) *ChainTaskInFlight {
	v := &ChainTaskInFlight{
		Knight:      t.Knight,
		Pod:         t.Pod,
		Node:        t.Node,
		Status:      t.Status,
		LostReason:  t.LostReason,
		StartedAt:   t.StartedAt.UTC().Format(time.RFC3339Nano),
		ElapsedMs:   nonNegMs(now.Sub(t.StartedAt)),
		CurrentTool: t.CurrentTool,
	}
	if t.LastHeartbeatAt != nil {
		hb := t.LastHeartbeatAt.UTC().Format(time.RFC3339Nano)
		age := nonNegMs(now.Sub(*t.LastHeartbeatAt))
		v.LastHeartbeat = &hb
		v.HeartbeatAgeMs = &age
	}
	return v
}

func nonNegMs(d time.Duration) int64 {
	if d < 0 {
		return 0
	}
	return d.Milliseconds()
}
