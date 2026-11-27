package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestMissionDetailExtraFields(t *testing.T) {
	router := setupTestRouter()
	mission := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "ai.roundtable.io/v1alpha1",
		"kind":       "Mission",
		"metadata": map[string]interface{}{
			"name": "detail-mission", "namespace": "test-namespace",
			"creationTimestamp": "2024-01-01T09:00:00Z",
		},
		"spec": map[string]interface{}{"objective": "x"},
		"status": map[string]interface{}{
			"phase":  "Pending",
			"result": strings.Repeat("é", 5000),
			"conditions": []interface{}{
				map[string]interface{}{"type": "Admitted", "status": "False", "reason": "MaxMissions", "message": "queued", "lastTransitionTime": "2024-01-01T09:01:00Z"},
				map[string]interface{}{"type": "Ready", "status": "False"},
			},
			"costBreakdown": []interface{}{
				map[string]interface{}{"name": "galahad", "costUSD": "1.25", "ephemeral": true},
				map[string]interface{}{"name": "bad", "costUSD": "n/a"},
			},
		},
	}}
	if _, err := dynClient.Resource(missionGVR).Namespace("test-namespace").Create(nil, mission, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/missions/detail-mission", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var d MissionDetail
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.Name != "detail-mission" || d.CreatedAt != "2024-01-01T09:00:00Z" {
		t.Errorf("name/createdAt: %q %q", d.Name, d.CreatedAt)
	}
	if len(d.Conditions) != 2 || d.Conditions[0].Reason != "MaxMissions" || d.Conditions[0].LastTransitionTime == "" {
		t.Errorf("conditions: %+v", d.Conditions)
	}
	if len(d.CostBreakdown) != 1 || d.CostBreakdown[0].Name != "galahad" || !d.CostBreakdown[0].Ephemeral {
		t.Errorf("costBreakdown: %+v", d.CostBreakdown)
	}
	if n := len([]rune(d.Result)); n != maxMissionResultChars {
		t.Errorf("result length %d", n)
	}

	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/missions", nil))
	var list []map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range list {
		if m["name"] != "detail-mission" {
			continue
		}
		found = true
		for _, k := range []string{"createdAt", "conditions", "costBreakdown", "result"} {
			if _, ok := m[k]; ok {
				t.Errorf("list payload has %q", k)
			}
		}
	}
	if !found {
		t.Error("mission missing from list")
	}
}

func TestMissionDetailOmitsEmptyFields(t *testing.T) {
	d := parseMissionDetail(map[string]interface{}{"metadata": map[string]interface{}{"name": "m"}}, MissionSummary{Name: "m"})
	b, _ := json.Marshal(d)
	for _, k := range []string{"createdAt", "conditions", "costBreakdown", "result"} {
		if strings.Contains(string(b), `"`+k+`"`) {
			t.Errorf("%s present: %s", k, b)
		}
	}
}
