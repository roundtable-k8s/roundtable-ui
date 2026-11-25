package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/gorilla/mux"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

// tableFixture installs a fake cluster with two tables and an untabled knight
// and returns a router serving every list endpoint (#273).
func tableFixture(t *testing.T) *mux.Router {
	t.Helper()
	oldDyn := dynClient
	t.Cleanup(func() { dynClient = oldDyn })
	dynClient = fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			knightGVR: "KnightList", chainGVR: "ChainList", missionGVR: "MissionList",
			triggerGVR: "TriggerList", roundTableGVR: "RoundTableList",
		})
	withQueueFixture(t, newFakeJetStream(), time.Now())

	create := func(gvr schema.GroupVersionResource, obj map[string]interface{}) {
		t.Helper()
		if _, err := dynClient.Resource(gvr).Namespace("test-namespace").
			Create(context.Background(), &unstructured.Unstructured{Object: obj}, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	knight := func(name, table string) {
		cr := makeQueueKnightCR(name, 2, 1)
		if table != "" {
			cr.SetLabels(map[string]string{labelRoundTable: table})
		}
		create(knightGVR, cr.Object)
	}
	withRef := func(kind, name, table string, spec map[string]interface{}) map[string]interface{} {
		if table != "" {
			spec["roundTableRef"] = map[string]interface{}{"name": table}
		}
		return map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1", "kind": kind,
			"metadata": map[string]interface{}{"name": name, "namespace": "test-namespace"},
			"spec":     spec,
		}
	}
	knight("galahad", "personal")
	knight("kay", "personal")
	knight("rt-ui", "roundtable-dev")
	knight("planner", "")
	create(chainGVR, withRef("Chain", "c-personal", "personal", map[string]interface{}{}))
	create(chainGVR, withRef("Chain", "c-dev", "roundtable-dev", map[string]interface{}{}))
	create(chainGVR, withRef("Chain", "c-none", "", map[string]interface{}{}))
	create(missionGVR, withRef("Mission", "m-personal", "personal", map[string]interface{}{"objective": "x"}))
	create(missionGVR, withRef("Mission", "m-none", "", map[string]interface{}{"objective": "x"}))
	chainRef := func(c string) map[string]interface{} {
		return map[string]interface{}{"chainRef": map[string]interface{}{"name": c}}
	}
	create(triggerGVR, withRef("Trigger", "t-dev", "", map[string]interface{}{"target": chainRef("c-dev")}))
	create(triggerGVR, withRef("Trigger", "t-personal", "", map[string]interface{}{"target": chainRef("c-personal")}))
	create(triggerGVR, withRef("Trigger", "t-none", "", map[string]interface{}{"target": chainRef("c-none")}))

	reg, _ := newTestRegistry(10)
	reg.handleActivity(activity(t, "task.started", "t1", 1, nil), "Galahad")
	reg.handleActivity(activity(t, "task.started", "t2", 1, map[string]any{"knight": "Rt-ui"}), "Rt-ui")
	reg.handleActivity(activity(t, "task.started", "t3", 1, map[string]any{"knight": "Planner"}), "Planner")

	r := mux.NewRouter()
	r.HandleFunc("/api/fleet", fleetHandler("test-namespace"))
	r.HandleFunc("/api/queues", queuesHandler("test-namespace"))
	r.HandleFunc("/api/chains", chainsHandler("test-namespace", nil))
	r.HandleFunc("/api/missions", missionsHandler("test-namespace"))
	r.HandleFunc("/api/triggers", triggersHandler("test-namespace"))
	r.HandleFunc("/api/running", runningHandler(reg, "test-namespace"))
	return r
}

func TestTableFilterAllListEndpoints(t *testing.T) {
	r := tableFixture(t)
	cases := []struct {
		path, nameKey, query string
		want                 []string // "name=table", sorted
	}{
		{"/api/fleet", "name", "", []string{"galahad=personal", "kay=personal", "planner=none", "rt-ui=roundtable-dev"}},
		{"/api/fleet", "name", "?table=personal", []string{"galahad=personal", "kay=personal"}},
		{"/api/fleet", "name", "?table=none", []string{"planner=none"}},
		{"/api/fleet", "name", "?table=nope", nil},
		{"/api/queues", "knight", "", []string{"galahad=personal", "kay=personal", "planner=none", "rt-ui=roundtable-dev"}},
		{"/api/queues", "knight", "?table=roundtable-dev", []string{"rt-ui=roundtable-dev"}},
		{"/api/queues", "knight", "?table=nope", nil},
		{"/api/chains", "name", "", []string{"c-dev=roundtable-dev", "c-none=none", "c-personal=personal"}},
		{"/api/chains", "name", "?table=personal", []string{"c-personal=personal"}},
		{"/api/chains", "name", "?table=nope", nil},
		{"/api/missions", "name", "", []string{"m-none=none", "m-personal=personal"}},
		{"/api/missions", "name", "?table=none", []string{"m-none=none"}},
		{"/api/missions", "name", "?table=nope", nil},
		{"/api/triggers", "name", "", []string{"t-dev=roundtable-dev", "t-none=none", "t-personal=personal"}},
		{"/api/triggers", "name", "?table=roundtable-dev", []string{"t-dev=roundtable-dev"}},
		{"/api/triggers", "name", "?table=nope", nil},
		{"/api/running", "taskId", "", []string{"t1=personal", "t2=roundtable-dev", "t3=none"}},
		{"/api/running", "taskId", "?table=personal", []string{"t1=personal"}},
		{"/api/running", "taskId", "?table=nope", nil},
	}
	for _, tc := range cases {
		t.Run(tc.path+tc.query, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tc.path+tc.query, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("status %d: %s", w.Code, w.Body.String())
			}
			var raw json.RawMessage = w.Body.Bytes()
			var items []map[string]interface{}
			var wrapped struct {
				Tasks []map[string]interface{} `json:"tasks"`
			}
			if tc.path == "/api/running" {
				if err := json.Unmarshal(raw, &wrapped); err != nil {
					t.Fatal(err)
				}
				items = wrapped.Tasks
			} else if err := json.Unmarshal(raw, &items); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, it := range items {
				n, _ := it[tc.nameKey].(string)
				tb, ok := it["table"].(string)
				if !ok {
					t.Fatalf("%s item %q has no table field", tc.path, n)
				}
				got = append(got, n+"="+tb)
			}
			sort.Strings(got)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}
