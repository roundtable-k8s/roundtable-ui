package main

import "testing"

func rtObj(spec, status map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{
		"metadata": map[string]interface{}{"name": "t", "namespace": "ns"},
		"spec":     spec,
		"status":   status,
	}
}

func TestParseRoundTablePlannerAndCounts(t *testing.T) {
	cases := []struct {
		name    string
		spec    map[string]interface{}
		status  map[string]interface{}
		knight  string
		enabled bool
		zero    int
		susp    int
		notRdy  int
	}{
		{"owned planner", map[string]interface{}{"planner": map[string]interface{}{"enabled": true}},
			map[string]interface{}{"plannerKnight": "dev-planner", "knightsScaledToZero": int64(2), "knightsSuspended": int64(1), "knightsNotReady": int64(3)},
			"dev-planner", true, 2, 1, 3},
		{"knightRef planner", map[string]interface{}{"planner": map[string]interface{}{"knightRef": map[string]interface{}{"name": "merlin"}}},
			map[string]interface{}{"plannerKnight": "merlin"}, "merlin", true, 0, 0, 0},
		{"disabled", map[string]interface{}{"planner": map[string]interface{}{"enabled": false}},
			map[string]interface{}{}, "", false, 0, 0, 0},
		{"ephemeral", map[string]interface{}{"ephemeral": true}, map[string]interface{}{"plannerKnight": "x"}, "x", false, 0, 0, 0},
		{"old status", map[string]interface{}{}, map[string]interface{}{"phase": "Ready", "knightsReady": int64(1)}, "", true, 0, 0, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rt := parseRoundTableResource(rtObj(c.spec, c.status))
			if rt.PlannerKnight != c.knight || rt.PlannerEnabled != c.enabled ||
				rt.KnightsScaledToZero != c.zero || rt.KnightsSuspended != c.susp || rt.KnightsNotReady != c.notRdy {
				t.Fatalf("got %+v", rt)
			}
		})
	}
}
