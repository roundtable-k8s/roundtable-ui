package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// loadChainFixture reads a Chain object as the dynamic client decodes it
// (JSON numbers become float64).
func loadChainFixture(t *testing.T, name string) map[string]interface{} {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "chains", name))
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]interface{}
	if err := json.Unmarshal(b, &obj); err != nil {
		t.Fatal(err)
	}
	return obj
}

func stepByName(t *testing.T, c ChainSummary, name string) StepSummary {
	t.Helper()
	for _, s := range c.Steps {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("step %q not found in %+v", name, c.Steps)
	return StepSummary{}
}

func TestParseChainResource_FanOut(t *testing.T) {
	c := parseChainResource(loadChainFixture(t, "fanout.json"), nil)
	if c.RunID != "1795548808" {
		t.Errorf("runId = %q", c.RunID)
	}

	scan := stepByName(t, c, "scan")
	if !scan.ForEach || scan.MaxParallel != 2 || scan.FailurePolicy != "continue" {
		t.Errorf("forEach spec not read: forEach=%v maxParallel=%d policy=%q", scan.ForEach, scan.MaxParallel, scan.FailurePolicy)
	}
	f := scan.FanOut
	if f == nil {
		t.Fatal("fanOut missing")
	}
	counts := []struct {
		name      string
		got, want int
	}{
		{"total", f.Total, 12},
		{"pending", f.Pending, 2},
		{"running", f.Running, 2},
		{"succeeded", f.Succeeded, 7},
		{"failed", f.Failed, 1},
		{"skipped", f.Skipped, 0},
		{"omittedItems", f.OmittedItems, 6},
		{"items", len(f.Items), 4},
	}
	for _, tc := range counts {
		if tc.got != tc.want {
			t.Errorf("%s = %d, want %d", tc.name, tc.got, tc.want)
		}
	}
	if f.ItemPhases != "SSSSSSFSRRPP" {
		t.Errorf("itemPhases = %q", f.ItemPhases)
	}

	items := []struct {
		index       int
		phase       string
		taskID      string
		err         string
		outputBytes int
		retries     int
		completed   bool
	}{
		{6, "Failed", "fanout-scan-1795548808-scan-6", "connection refused", 0, 2, true},
		{7, "Succeeded", "fanout-scan-1795548808-scan-7", "", len("22/tcp open"), 0, true},
		{8, "Running", "fanout-scan-1795548808-scan-8", "", 0, 0, false},
		{9, "Running", "fanout-scan-1795548808-scan-9", "", 0, 0, false},
	}
	for i, want := range items {
		got := f.Items[i] // sorted by index
		if got.Index != want.index || got.Phase != want.phase || got.TaskID != want.taskID ||
			got.Error != want.err || got.OutputBytes != want.outputBytes || got.Retries != want.retries ||
			(got.CompletionTime != nil) != want.completed {
			t.Errorf("item %d = %+v, want %+v", i, got, want)
		}
		if got.InFlight != nil {
			t.Errorf("item %d: inFlight set without a registry", i)
		}
	}

	steps := []struct {
		name        string
		skipped     bool
		skipReason  string
		skipMessage string
		when        string
	}{
		{"discover", false, "", "", ""},
		{"notify", true, "WhenFalse", `when evaluated to false: steps.discover.output.contains("urgent")`, `steps.discover.output.contains("urgent")`},
		{"cleanup", false, "", "", ""},
	}
	for _, tc := range steps {
		s := stepByName(t, c, tc.name)
		if s.Skipped != tc.skipped || s.SkipReason != tc.skipReason || s.SkipMessage != tc.skipMessage || s.When != tc.when {
			t.Errorf("%s: skipped=%v reason=%q message=%q when=%q", tc.name, s.Skipped, s.SkipReason, s.SkipMessage, s.When)
		}
		if s.FanOut != nil || s.Loop != nil || s.ForEach {
			t.Errorf("%s: unexpected fanOut/loop", tc.name)
		}
	}
	if d := stepByName(t, c, "discover"); d.TaskID != "fanout-scan-1795548808-discover" {
		t.Errorf("discover taskId = %q", d.TaskID)
	}
}

func TestParseChainResource_LoopingPRPipeline(t *testing.T) {
	c := parseChainResource(loadChainFixture(t, "pr-pipeline-loop.json"), nil)
	if c.CurrentStep != "fixloop" {
		t.Errorf("currentStep = %q", c.CurrentStep)
	}
	l := stepByName(t, c, "fixloop").Loop
	if l == nil {
		t.Fatal("loop missing")
	}
	if l.Iteration != 2 || l.MaxIterations != 3 || l.OnExhausted != "continue" || l.Outcome != "" {
		t.Errorf("loop state = %+v", l)
	}
	if l.From != "review" || l.Until != `last.output.contains("Verdict: ship it")` {
		t.Errorf("loop spec = from %q until %q", l.From, l.Until)
	}
	if len(l.Body) != 2 || l.Body[0] != "fix" || l.Body[1] != "rereview" {
		t.Errorf("body = %v", l.Body)
	}
	rounds := []struct {
		iteration int
		step      string
		knight    string
		phase     string
		outBytes  int
	}{
		{1, "rereview", "rt-reviewer", "Succeeded", len("Verdict: needs fixes")},
		{2, "fix", "rt-ui", "Running", 0},
	}
	if len(l.Rounds) != len(rounds) {
		t.Fatalf("rounds = %+v", l.Rounds)
	}
	for i, want := range rounds {
		r := l.Rounds[i]
		if r.Iteration != want.iteration || len(r.Steps) != 1 {
			t.Errorf("round %d = %+v", i, r)
			continue
		}
		s := r.Steps[0]
		if s.Name != want.step || s.Knight != want.knight || s.Phase != want.phase || s.Iteration != want.iteration || s.OutputBytes != want.outBytes {
			t.Errorf("round %d step = %+v, want %+v", i, s, want)
		}
	}
	for _, name := range []string{"merge", "needs-human"} {
		s := stepByName(t, c, name)
		if s.When == "" || s.Skipped {
			t.Errorf("%s: when=%q skipped=%v", name, s.When, s.Skipped)
		}
	}
}

func TestParseChainResource_SpecOnlyExtras(t *testing.T) {
	obj := loadChainFixture(t, "pr-pipeline-loop.json")
	delete(obj, "status")
	c := parseChainResource(obj, nil)
	if c.RunID != "" {
		t.Errorf("runId = %q", c.RunID)
	}
	l := stepByName(t, c, "fixloop").Loop
	if l == nil || l.Iteration != 0 || l.MaxIterations != 3 || l.OnExhausted != "continue" || len(l.Body) != 2 || len(l.Rounds) != 0 {
		t.Errorf("spec-only loop = %+v", l)
	}
	if s := stepByName(t, c, "merge"); s.When == "" || s.Phase != "Pending" {
		t.Errorf("merge = %+v", s)
	}

	// Defaults: failurePolicy failFast, onExhausted fail, maxIterations 3.
	c = parseChainResource(map[string]interface{}{
		"spec": map[string]interface{}{"steps": []interface{}{
			map[string]interface{}{"name": "fan", "forEach": map[string]interface{}{"from": "x"}},
			map[string]interface{}{"name": "lp", "loop": map[string]interface{}{"until": "true", "steps": []interface{}{
				map[string]interface{}{"name": "b"},
			}}},
		}},
	}, nil)
	if s := stepByName(t, c, "fan"); !s.ForEach || s.FailurePolicy != "failFast" || s.MaxParallel != 0 {
		t.Errorf("fan defaults = %+v", s)
	}
	if l := stepByName(t, c, "lp").Loop; l == nil || l.MaxIterations != 3 || l.OnExhausted != "fail" {
		t.Errorf("loop defaults = %+v", l)
	}
}

func TestSkipMessage(t *testing.T) {
	cases := []struct{ reason, when, want string }{
		{"WhenFalse", "x == 1", "when evaluated to false: x == 1"},
		{"WhenFalse", "", "when evaluated to false"},
		{"ChainFailed", "x", "the chain failed before this step ran"},
		{"", "", ""},
		{"Other", "", "Other"},
	}
	for _, tc := range cases {
		if got := skipMessage(tc.reason, tc.when); got != tc.want {
			t.Errorf("skipMessage(%q, %q) = %q, want %q", tc.reason, tc.when, got, tc.want)
		}
	}
}

func TestJoinChainInFlight(t *testing.T) {
	reg, _ := newTestRegistry(100) // clock at 2026-11-24T12:00:00Z
	start := map[string]any{"ts": "2026-11-24T11:58:00Z"}
	reg.handleActivity(activity(t, "task.started", "fanout-scan-1795548808-scan-8", 1, start), "Galahad")
	reg.handleActivity(activity(t, "task.heartbeat", "fanout-scan-1795548808-scan-8", 2,
		map[string]any{"ts": "2026-11-24T11:59:50Z", "currentTool": "bash"}), "Galahad")
	// Item 9 started but no heartbeat yet.
	reg.handleActivity(activity(t, "task.started", "fanout-scan-1795548808-scan-9", 1,
		map[string]any{"ts": "2026-11-24T11:59:00Z", "pod": "galahad-abc-2"}), "Galahad")
	// A finished item whose taskId is (wrongly) still in the registry must not
	// be joined: only Running entries are.
	reg.handleActivity(activity(t, "task.started", "fanout-scan-1795548808-scan-7", 1, start), "Galahad")
	// Loop body task.
	reg.handleActivity(activity(t, "task.started", "pr-1795548808-fixloop-fix-2", 1,
		map[string]any{"ts": "2026-11-24T11:58:00Z", "knight": "rt-ui", "pod": "rt-ui-0"}), "rt-ui")
	// Plain running step.
	reg.handleActivity(activity(t, "task.started", "fanout-scan-1795548808-discover", 1, start), "Galahad")

	t.Run("fan-out items", func(t *testing.T) {
		c := parseChainResource(loadChainFixture(t, "fanout.json"), nil)
		joinChainInFlight(&c, reg)
		items := stepByName(t, c, "scan").FanOut.Items
		cases := []struct {
			index      int
			wantPod    string
			elapsedMs  int64
			hbAgeMs    int64 // -1: no heartbeat
			wantJoined bool
		}{
			{6, "", 0, 0, false},
			{7, "", 0, 0, false},
			{8, "galahad-abc-1", 120000, 10000, true},
			{9, "galahad-abc-2", 60000, -1, true},
		}
		for i, tc := range cases {
			got := items[i].InFlight
			if (got != nil) != tc.wantJoined {
				t.Errorf("item %d: inFlight = %+v, want joined=%v", tc.index, got, tc.wantJoined)
				continue
			}
			if got == nil {
				continue
			}
			if got.Pod != tc.wantPod || got.ElapsedMs != tc.elapsedMs || got.Status != "running" || got.Knight != "Galahad" {
				t.Errorf("item %d: inFlight = %+v", tc.index, got)
			}
			if tc.hbAgeMs < 0 {
				if got.HeartbeatAgeMs != nil || got.LastHeartbeat != nil {
					t.Errorf("item %d: unexpected heartbeat %+v", tc.index, got)
				}
			} else if got.HeartbeatAgeMs == nil || *got.HeartbeatAgeMs != tc.hbAgeMs || got.LastHeartbeat == nil {
				t.Errorf("item %d: heartbeat age = %v", tc.index, got.HeartbeatAgeMs)
			}
		}
		if items[0].InFlight != nil || items[1].InFlight != nil {
			t.Error("finished items must not be joined")
		}
		if items[2].InFlight.CurrentTool != "bash" {
			t.Errorf("currentTool = %q", items[2].InFlight.CurrentTool)
		}
		// discover is Succeeded, so its registry entry is ignored.
		if s := stepByName(t, c, "discover"); s.InFlight != nil {
			t.Errorf("succeeded step joined: %+v", s.InFlight)
		}
	})

	t.Run("loop body and plain step", func(t *testing.T) {
		c := parseChainResource(loadChainFixture(t, "pr-pipeline-loop.json"), nil)
		joinChainInFlight(&c, reg)
		rounds := stepByName(t, c, "fixloop").Loop.Rounds
		if rounds[0].Steps[0].InFlight != nil {
			t.Error("finished body step joined")
		}
		fix := rounds[1].Steps[0].InFlight
		if fix == nil || fix.Pod != "rt-ui-0" || fix.ElapsedMs != 120000 {
			t.Errorf("fix inFlight = %+v", fix)
		}

		obj := loadChainFixture(t, "fanout.json")
		ss := obj["status"].(map[string]interface{})["stepStatuses"].([]interface{})
		ss[0].(map[string]interface{})["phase"] = "Running"
		c = parseChainResource(obj, nil)
		joinChainInFlight(&c, reg)
		if s := stepByName(t, c, "discover"); s.InFlight == nil || s.InFlight.ElapsedMs != 120000 {
			t.Errorf("running step inFlight = %+v", s.InFlight)
		}
	})

	t.Run("nil registry", func(t *testing.T) {
		c := parseChainResource(loadChainFixture(t, "fanout.json"), nil)
		joinChainInFlight(&c, nil)
		for _, it := range stepByName(t, c, "scan").FanOut.Items {
			if it.InFlight != nil {
				t.Errorf("item %d joined with nil registry", it.Index)
			}
		}
	})
}

func TestChainDetailHandler_InFlightJoin(t *testing.T) {
	setupTestRouter() // installs the fake dynamic client
	obj := loadChainFixture(t, "fanout.json")
	if _, err := dynClient.Resource(chainGVR).Namespace("roundtable").Create(context.Background(),
		&unstructured.Unstructured{Object: obj}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	reg, _ := newTestRegistry(100)
	reg.handleActivity(activity(t, "task.started", "fanout-scan-1795548808-scan-8", 1,
		map[string]any{"ts": "2026-11-24T11:59:00Z"}), "Galahad")

	r := mux.NewRouter()
	r.HandleFunc("/api/chains/{name}", chainDetailHandler("roundtable", reg))
	r.HandleFunc("/api/chains", chainsHandler("roundtable", reg))

	for _, path := range []string{"/api/chains/fanout-scan", "/api/chains?full=true"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("%s: status %d: %s", path, w.Code, w.Body.String())
		}
		var c ChainSummary
		if path == "/api/chains?full=true" {
			var list []ChainSummary
			if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list) != 1 {
				t.Fatalf("list: %v %s", err, w.Body.String())
			}
			c = list[0]
		} else if err := json.Unmarshal(w.Body.Bytes(), &c); err != nil {
			t.Fatal(err)
		}
		items := stepByName(t, c, "scan").FanOut.Items
		if items[2].Index != 8 || items[2].InFlight == nil || items[2].InFlight.Pod != "galahad-abc-1" || items[2].InFlight.ElapsedMs != 60000 {
			t.Errorf("%s: item 8 = %+v", path, items[2])
		}
		if items[3].InFlight != nil {
			t.Errorf("%s: item 9 joined without a registry entry", path)
		}
	}
}

func TestParseChainResource_Scheduled(t *testing.T) {
	obj := map[string]interface{}{
		"metadata": map[string]interface{}{"name": "morning-briefing-phase1"},
		"spec":     map[string]interface{}{"schedule": "0 11 * * *", "timeZone": "UTC", "suspend": true},
		"status": map[string]interface{}{
			"nextScheduledAt": "2026-11-26T11:00:00Z",
			"lastScheduledAt": "2026-11-25T11:00:00Z",
			"runsCompleted":   int64(3),
		},
	}
	c := parseChainResource(obj, nil)
	if c.TimeZone != "UTC" || c.NextScheduledAt != "2026-11-26T11:00:00Z" || c.LastScheduledAt != "2026-11-25T11:00:00Z" || !c.Suspend || c.RunsCompleted != 3 {
		t.Errorf("scheduled = %+v", c)
	}
	b, _ := json.Marshal(c)
	if !strings.Contains(string(b), `"nextScheduledAt":"2026-11-26T11:00:00Z"`) {
		t.Errorf("json missing nextScheduledAt: %s", b)
	}

	plain := parseChainResource(map[string]interface{}{
		"metadata": map[string]interface{}{"name": "x"},
		"spec":     map[string]interface{}{},
	}, nil)
	b, _ = json.Marshal(plain)
	for _, k := range []string{"timeZone", "nextScheduledAt", "lastScheduledAt"} {
		if strings.Contains(string(b), k) {
			t.Errorf("unscheduled chain should omit %s: %s", k, b)
		}
	}
}

func TestParseChainResource_LoopHistory(t *testing.T) {
	obj := loadChainFixture(t, "loop-history.json")
	l := stepByName(t, parseChainResource(obj, nil), "fixloop").Loop
	if l == nil || len(l.Rounds) != 3 {
		t.Fatalf("rounds = %+v", l)
	}
	for i, r := range l.Rounds {
		if r.Iteration != i+1 || len(r.Steps) != 2 {
			t.Fatalf("round %d = %+v", i, r)
		}
		// body order: fix before rereview
		if r.Steps[0].Name != "fix" || r.Steps[1].Name != "rereview" {
			t.Errorf("round %d order = %s, %s", r.Iteration, r.Steps[0].Name, r.Steps[1].Name)
		}
	}
	fix1 := l.Rounds[0].Steps[0]
	if fix1.Phase != "Failed" || fix1.Error != "task timed out after 10m" || fix1.TaskID != "t-fix-1" || fix1.Knight != "rt-ui" {
		t.Errorf("round 1 fix = %+v", fix1)
	}
	if fix1.StartTime == nil || fix1.CompletionTime == nil || *fix1.CompletionTime != "2026-11-24T11:40:00Z" {
		t.Errorf("round 1 fix times = %+v", fix1)
	}
	re1 := l.Rounds[0].Steps[1]
	if re1.OutputSummary != "Verdict: needs fixes" || re1.OutputBytes != len(re1.OutputSummary) {
		t.Errorf("round 1 rereview = %+v", re1)
	}
	// Round 3 fix is in both history and steps: shown once, live entry wins.
	fix3 := l.Rounds[2].Steps[0]
	if fix3.OutputSummary != "" || fix3.OutputBytes != len("patched") {
		t.Errorf("round 3 fix should be the live entry: %+v", fix3)
	}

	// Without history (older operator): only the latest run of each step.
	delete(stepStatusMap(t, obj, "fixloop")["loop"].(map[string]interface{}), "history")
	l = stepByName(t, parseChainResource(obj, nil), "fixloop").Loop
	if len(l.Rounds) != 1 || l.Rounds[0].Iteration != 3 || len(l.Rounds[0].Steps) != 2 {
		t.Errorf("no-history rounds = %+v", l.Rounds)
	}
}

func stepStatusMap(t *testing.T, obj map[string]interface{}, name string) map[string]interface{} {
	t.Helper()
	for _, s := range obj["status"].(map[string]interface{})["stepStatuses"].([]interface{}) {
		if m := s.(map[string]interface{}); m["name"] == name {
			return m
		}
	}
	t.Fatalf("no step status %q", name)
	return nil
}

func TestSlimChain_DropsLoopHistory(t *testing.T) {
	c := parseChainResource(loadChainFixture(t, "loop-history.json"), nil)
	b, err := json.Marshal(slimChain(c))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "t-fix-1") || strings.Contains(string(b), "timed out") {
		t.Errorf("slim list carries loop history: %s", b)
	}
}
