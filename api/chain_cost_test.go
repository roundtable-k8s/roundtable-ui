package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestParseChainResource_Cost(t *testing.T) {
	knights := map[string]knightInfo{
		"lancelot": {Domain: "planning", PlanBacked: true},
		"galahad":  {Domain: "security"},
	}
	c := parseChainResource(loadChainFixture(t, "cost.json"), knights)

	plan := stepByName(t, c, "plan")
	if plan.CostUSD != "0.250000" || plan.Tokens == nil || *plan.Tokens != (TokenTotals{10000, 1500}) || !plan.CostNotional {
		t.Errorf("plan cost = %q tokens=%+v notional=%v", plan.CostUSD, plan.Tokens, plan.CostNotional)
	}
	build := stepByName(t, c, "build")
	if build.CostUSD != "0.500000" || build.Tokens == nil || *build.Tokens != (TokenTotals{20000, 3000}) || build.CostNotional {
		t.Errorf("build cost = %q tokens=%+v notional=%v", build.CostUSD, build.Tokens, build.CostNotional)
	}
	notify := stepByName(t, c, "notify")
	if notify.CostUSD != "" || notify.Tokens != nil || notify.CostNotional {
		t.Errorf("skipped step has cost: %+v", notify)
	}

	if c.CostUSD != "0.750000" || c.Tokens == nil || *c.Tokens != (TokenTotals{30000, 4500}) {
		t.Errorf("run total = %q tokens=%+v", c.CostUSD, c.Tokens)
	}
	if c.NotionalCostUSD != "0.250000" {
		t.Errorf("notional = %q, want 0.250000", c.NotionalCostUSD)
	}

	// A finished run's total equals the sum of its steps.
	var sum float64
	for _, s := range c.Steps {
		v, _ := parseCost(s.CostUSD)
		sum += v
	}
	if total, _ := parseCost(c.CostUSD); formatCostUSD(total) != formatCostUSD(sum) {
		t.Errorf("total %v != sum of steps %v", total, sum)
	}
}

func TestParseChainResource_CostFallsBackToStepSum(t *testing.T) {
	obj := loadChainFixture(t, "cost.json")
	status := obj["status"].(map[string]interface{})
	delete(status, "costUSD")
	delete(status, "tokens")
	c := parseChainResource(obj, nil)
	if c.CostUSD != "0.750000" || c.Tokens == nil || *c.Tokens != (TokenTotals{30000, 4500}) {
		t.Errorf("summed total = %q tokens=%+v", c.CostUSD, c.Tokens)
	}
	if c.NotionalCostUSD != "" {
		t.Errorf("notional without knight info = %q", c.NotionalCostUSD)
	}
}

func TestParseChainResource_NoCost(t *testing.T) {
	c := parseChainResource(loadChainFixture(t, "fanout.json"), nil)
	if c.CostUSD != "" || c.Tokens != nil || c.NotionalCostUSD != "" {
		t.Errorf("chain without cost data: costUSD=%q tokens=%+v notional=%q", c.CostUSD, c.Tokens, c.NotionalCostUSD)
	}
	for _, s := range c.Steps {
		if s.CostUSD != "" || s.Tokens != nil || s.CostNotional {
			t.Errorf("step %s has cost: %+v", s.Name, s)
		}
	}
	b, _ := json.Marshal(c)
	var raw map[string]interface{}
	_ = json.Unmarshal(b, &raw)
	for _, k := range []string{"costUSD", "tokens", "notionalCostUSD"} {
		if _, ok := raw[k]; ok {
			t.Errorf("%s present in JSON without cost data", k)
		}
	}

	// A malformed cost string is dropped, not passed through.
	obj := loadChainFixture(t, "cost.json")
	obj["status"].(map[string]interface{})["costUSD"] = "n/a"
	if c := parseChainResource(obj, nil); c.CostUSD != "" {
		t.Errorf("malformed costUSD passed through: %q", c.CostUSD)
	}
}

func TestKnightInfoFromSpec(t *testing.T) {
	cases := []struct {
		name string
		spec map[string]interface{}
		want bool
	}{
		{"claude-knight image", map[string]interface{}{"image": "ghcr.io/roundtable-k8s/claude-knight:v1.2.3"}, true},
		{"claude-knight variant digest", map[string]interface{}{"image": "ghcr.io/x/claude-knight-dev@sha256:abc"}, true},
		{"pi-knight image", map[string]interface{}{"image": "ghcr.io/roundtable-k8s/pi-knight:v1"}, false},
		{"default image", map[string]interface{}{}, false},
		{"explicit false wins", map[string]interface{}{"image": "claude-knight:v1", "planBacked": false}, false},
		{"explicit true wins", map[string]interface{}{"image": "pi-knight:v1", "planBacked": true}, true},
		{"lookalike", map[string]interface{}{"image": "ghcr.io/x/claude-knightly:v1"}, false},
	}
	for _, tc := range cases {
		if got := knightInfoFromSpec(tc.spec).PlanBacked; got != tc.want {
			t.Errorf("%s: planBacked = %v, want %v", tc.name, got, tc.want)
		}
	}
	if d := knightInfoFromSpec(map[string]interface{}{"domain": "security"}).Domain; d != "security" {
		t.Errorf("domain = %q", d)
	}
}

func TestMissionHandler_Cost(t *testing.T) {
	router := setupTestRouter()
	ctx := context.Background()
	ns := "test-namespace"

	knight := func(name, image string) *unstructured.Unstructured {
		return &unstructured.Unstructured{Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1", "kind": "Knight",
			"metadata": map[string]interface{}{"name": name, "namespace": ns},
			"spec":     map[string]interface{}{"domain": "dev", "image": image},
		}}
	}
	for _, k := range []*unstructured.Unstructured{
		knight("lancelot", "ghcr.io/roundtable-k8s/claude-knight:v1"),
		knight("galahad", "ghcr.io/roundtable-k8s/pi-knight:v1"),
	} {
		if _, err := dynClient.Resource(knightGVR).Namespace(ns).Create(ctx, k, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	chainObj := loadChainFixture(t, "cost.json")
	chainObj["metadata"] = map[string]interface{}{"name": "costly-mission-build", "namespace": ns}
	if _, err := dynClient.Resource(chainGVR).Namespace(ns).Create(ctx, &unstructured.Unstructured{Object: chainObj}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	mission := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "ai.roundtable.io/v1alpha1", "kind": "Mission",
		"metadata": map[string]interface{}{"name": "costly-mission", "namespace": ns},
		"spec":     map[string]interface{}{"objective": "spend"},
		"status": map[string]interface{}{
			"phase":     "Succeeded",
			"totalCost": "0.7500",
			"tokens":    map[string]interface{}{"input": int64(30000), "output": int64(4500)},
			"chainStatuses": []interface{}{
				map[string]interface{}{
					"name": "build", "chainCRName": "costly-mission-build", "phase": "Succeeded",
					"costUSD": "0.750000",
					"tokens":  map[string]interface{}{"input": int64(30000), "output": int64(4500)},
				},
				// No cost data and no Chain resource: renders without cost.
				map[string]interface{}{"name": "gone", "chainCRName": "costly-mission-gone", "phase": "Pending"},
			},
		},
	}}
	if _, err := dynClient.Resource(missionGVR).Namespace(ns).Create(ctx, mission, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	check := func(m MissionSummary) {
		t.Helper()
		if m.TotalCost != "0.7500" || m.Tokens == nil || *m.Tokens != (TokenTotals{30000, 4500}) {
			t.Errorf("mission totals: cost=%q tokens=%+v", m.TotalCost, m.Tokens)
		}
		if m.NotionalCostUSD != "0.250000" {
			t.Errorf("mission notional = %q", m.NotionalCostUSD)
		}
		if len(m.ChainStatuses) != 2 {
			t.Fatalf("chainStatuses = %+v", m.ChainStatuses)
		}
		cs := m.ChainStatuses[0]
		if cs.CostUSD != "0.750000" || cs.Tokens == nil || *cs.Tokens != (TokenTotals{30000, 4500}) || cs.NotionalCostUSD != "0.250000" {
			t.Errorf("chain cost = %+v tokens=%+v", cs, cs.Tokens)
		}
		gone := m.ChainStatuses[1]
		if gone.CostUSD != "" || gone.Tokens != nil || gone.NotionalCostUSD != "" {
			t.Errorf("chain without cost = %+v", gone)
		}
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/missions/costly-mission", nil))
	if w.Code != 200 {
		t.Fatalf("detail status = %d: %s", w.Code, w.Body.String())
	}
	var m MissionSummary
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	check(m)

	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/missions", nil))
	var list []MissionSummary
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range list {
		if m.Name == "costly-mission" {
			found = true
			check(m)
		}
	}
	if !found {
		t.Fatalf("costly-mission not listed: %s", w.Body.String())
	}

	// The chain endpoint carries the same per-step split.
	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/chains/costly-mission-build", nil))
	var c ChainSummary
	if err := json.Unmarshal(w.Body.Bytes(), &c); err != nil {
		t.Fatalf("chain detail: %v (%s)", err, w.Body.String())
	}
	if !stepByName(t, c, "plan").CostNotional || stepByName(t, c, "build").CostNotional || c.CostUSD != "0.750000" {
		t.Errorf("chain detail cost: %+v", c)
	}
}
