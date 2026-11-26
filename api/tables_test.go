package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/gorilla/mux"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

const tablesTestNS = "roundtable"

func makeRoundTable(name, prefix, tasksStream, resultsStream string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "ai.roundtable.io/v1alpha1",
		"kind":       "RoundTable",
		"metadata":   map[string]interface{}{"name": name, "namespace": tablesTestNS},
		"spec": map[string]interface{}{
			"nats": map[string]interface{}{
				"subjectPrefix": prefix,
				"tasksStream":   tasksStream,
				"resultsStream": resultsStream,
			},
		},
	}}
}

func makeTableKnight(name, domain, prefix string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "ai.roundtable.io/v1alpha1",
		"kind":       "Knight",
		"metadata":   map[string]interface{}{"name": name, "namespace": tablesTestNS},
		"spec": map[string]interface{}{
			"domain": domain,
			"nats": map[string]interface{}{
				"subjects": []interface{}{prefix + ".tasks." + domain + ".>"},
			},
		},
	}}
}

// withTwoTables installs a fake dynamic client holding two RoundTables on
// different prefixes (fleet-a and rt-dev) and one knight in each.
func withTwoTables(t *testing.T) {
	t.Helper()
	old := dynClient
	t.Cleanup(func() { dynClient = old })
	dynClient = fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{roundTableGVR: "RoundTableList", knightGVR: "KnightList"},
		makeRoundTable("fleet-a", "fleet-a", "fleet_a_tasks", "fleet_a_results"),
		makeRoundTable("roundtable-dev", "rt-dev", "rt_dev_tasks", "rt_dev_results"),
		makeTableKnight("galahad", "security", "fleet-a"),
		makeTableKnight("rt-ui", "ui", "rt-dev"),
	)
}

// stubResults replaces the JetStream reader with canned per-stream events.
func stubResults(t *testing.T, byStream map[string][]TaskEvent, failing ...string) *[]string {
	t.Helper()
	old := readResults
	t.Cleanup(func() { readResults = old })
	var filters []string
	readResults = func(_ context.Context, stream, filter string, limit int) ([]TaskEvent, uint64, error) {
		for _, f := range failing {
			if f == stream {
				return nil, 0, errors.New("stream not found")
			}
		}
		filters = append(filters, stream+" "+filter)
		evs := byStream[stream]
		return append([]TaskEvent(nil), evs...), uint64(len(evs)), nil
	}
	return &filters
}

func resultEvent(subject string, ts time.Time) TaskEvent {
	data, _ := json.Marshal(map[string]interface{}{"timestamp": ts})
	return TaskEvent{Type: "result", Subject: subject, Data: data, Timestamp: ts}
}

func TestResolveTables(t *testing.T) {
	discovered := []TableInfo{
		{Name: "roundtable-dev", Prefix: "rt-dev", ResultsStream: "rt_dev_results"},
		{Name: "fleet-a", Prefix: "fleet-a", ResultsStream: "fleet_a_results"},
		{Name: "zz-dup", Prefix: "rt-dev", ResultsStream: "other"},
	}

	got := resolveTables(discovered, "", "")
	want := []TableInfo{
		{Name: "fleet-a", Prefix: "fleet-a", ResultsStream: "fleet_a_results"},
		{Name: "roundtable-dev", Prefix: "rt-dev", ResultsStream: "rt_dev_results"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("no filter: got %+v, want %+v", got, want)
	}

	// FLEET_PREFIX narrows to one table; FLEET_STREAM overrides its stream.
	got = resolveTables(discovered, "rt-dev", "custom_results")
	want = []TableInfo{{Name: "roundtable-dev", Prefix: "rt-dev", ResultsStream: "custom_results"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("filter: got %+v, want %+v", got, want)
	}

	// Nothing discovered: the env pair is the only table (pre-#239 behaviour).
	got = resolveTables(nil, "fleet-a", "fleet_a_results")
	want = []TableInfo{{Name: "fleet-a", Prefix: "fleet-a", ResultsStream: "fleet_a_results"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("env only: got %+v, want %+v", got, want)
	}
	// FLEET_PREFIX matching no table falls back to it as well.
	if got = resolveTables(discovered, "chelonian", ""); got[0].Prefix != "chelonian" || got[0].ResultsStream != legacyFleetStream {
		t.Errorf("unmatched filter: got %+v", got)
	}
	// No env, nothing discovered: legacy defaults.
	if got = resolveTables(nil, "", ""); got[0].Prefix != legacyFleetPrefix || got[0].ResultsStream != legacyFleetStream {
		t.Errorf("defaults: got %+v", got)
	}
}

func TestTableFromRoundTableRejectsWildcardPrefix(t *testing.T) {
	if _, ok := tableFromRoundTable(context.Background(), makeRoundTable("bad", "fleet.>", "a", "b")); ok {
		t.Error("wildcard prefix accepted")
	}
	tbl, ok := tableFromRoundTable(context.Background(), makeRoundTable("ok", "rt-dev", "t", "bad stream"))
	if !ok || tbl.ResultsStream != "" || tbl.TasksStream != "t" {
		t.Errorf("got %+v ok=%v", tbl, ok)
	}
}

func TestTableSourceDiscoversAndCaches(t *testing.T) {
	withTwoTables(t)
	src := newTableSource(tablesTestNS, "", "")
	now := time.Unix(1000, 0)
	src.now = func() time.Time { return now }

	if got := src.prefixes(context.Background()); !reflect.DeepEqual(got, []string{"fleet-a", "rt-dev"}) {
		t.Fatalf("prefixes = %v", got)
	}

	// A table added within the TTL is not seen until the cache expires.
	_, err := dynClient.Resource(roundTableGVR).Namespace(tablesTestNS).Create(context.Background(),
		makeRoundTable("chelonian", "chelonian", "c_tasks", "c_results"), metav1.CreateOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if got := src.tables(context.Background()); len(got) != 2 {
		t.Fatalf("cached tables = %+v", got)
	}
	now = now.Add(tableCacheTTL)
	if got := src.tables(context.Background()); len(got) != 3 {
		t.Fatalf("refreshed tables = %+v", got)
	}
}

func TestTableSourceWithoutKubernetes(t *testing.T) {
	old := dynClient
	dynClient = nil
	t.Cleanup(func() { dynClient = old })

	got := newTableSource(tablesTestNS, "fleet-a", "fleet_a_results").tables(context.Background())
	want := []TableInfo{{Name: "fleet-a", Prefix: "fleet-a", ResultsStream: "fleet_a_results"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %+v, want %+v", got, want)
	}
}

func tasksRouter(src *tableSource) *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/api/tasks", taskHistoryHandler(src)).Methods("GET")
	return r
}

type historyResponse struct {
	Results     []TaskEvent `json:"results"`
	Messages    uint64      `json:"messages"`
	Tables      []TableInfo `json:"tables"`
	Unavailable []string    `json:"unavailable"`
}

func getHistory(t *testing.T, r http.Handler, url string) (int, historyResponse) {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", url, nil))
	var resp historyResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v (%s)", err, w.Body.String())
		}
	}
	return w.Code, resp
}

func TestTaskHistoryCoversEveryTable(t *testing.T) {
	withTwoTables(t)
	base := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	filters := stubResults(t, map[string][]TaskEvent{
		"fleet_a_results": {resultEvent("fleet-a.results.t1", base), resultEvent("fleet-a.results.t3", base.Add(2*time.Minute))},
		"rt_dev_results":  {resultEvent("rt-dev.results.t2", base.Add(time.Minute))},
	})
	r := tasksRouter(newTableSource(tablesTestNS, "", ""))

	code, resp := getHistory(t, r, "/api/tasks")
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	var got []string
	for _, e := range resp.Results {
		got = append(got, e.Table+" "+e.Subject)
	}
	want := []string{ // merged oldest first, each labelled with its table
		"fleet-a fleet-a.results.t1",
		"roundtable-dev rt-dev.results.t2",
		"fleet-a fleet-a.results.t3",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("results = %v, want %v", got, want)
	}
	if resp.Messages != 3 || len(resp.Tables) != 2 {
		t.Errorf("messages=%d tables=%+v", resp.Messages, resp.Tables)
	}
	wantFilters := []string{"fleet_a_results fleet-a.results.>", "rt_dev_results rt-dev.results.>"}
	if !reflect.DeepEqual(*filters, wantFilters) {
		t.Errorf("filters = %v", *filters)
	}

	// ?table= narrows to one table.
	_, resp = getHistory(t, r, "/api/tasks?table=roundtable-dev")
	if len(resp.Results) != 1 || resp.Results[0].Table != "roundtable-dev" {
		t.Errorf("filtered = %+v", resp.Results)
	}
	if code, _ := getHistory(t, r, "/api/tasks?table=nope"); code != http.StatusBadRequest {
		t.Errorf("unknown table status = %d", code)
	}
}

func TestTaskHistoryPartialAndTotalFailure(t *testing.T) {
	withTwoTables(t)
	stubResults(t, map[string][]TaskEvent{
		"fleet_a_results": {resultEvent("fleet-a.results.t1", time.Now())},
	}, "rt_dev_results")
	r := tasksRouter(newTableSource(tablesTestNS, "", ""))

	code, resp := getHistory(t, r, "/api/tasks")
	if code != http.StatusOK || len(resp.Results) != 1 || !reflect.DeepEqual(resp.Unavailable, []string{"roundtable-dev"}) {
		t.Errorf("partial: code=%d resp=%+v", code, resp)
	}
	if code, _ := getHistory(t, r, "/api/tasks?table=roundtable-dev"); code != http.StatusInternalServerError {
		t.Errorf("all failing: status %d", code)
	}
}

// A single-table install with the env pair set reads only that stream, as before.
func TestTaskHistorySingleTableEnv(t *testing.T) {
	withTwoTables(t)
	filters := stubResults(t, map[string][]TaskEvent{
		"fleet_a_results": {resultEvent("fleet-a.results.t1", time.Now())},
		"rt_dev_results":  {resultEvent("rt-dev.results.t2", time.Now())},
	})
	r := tasksRouter(newTableSource(tablesTestNS, "fleet-a", "fleet_a_results"))
	_, resp := getHistory(t, r, "/api/tasks")
	if len(resp.Results) != 1 || resp.Results[0].Subject != "fleet-a.results.t1" {
		t.Errorf("results = %+v", resp.Results)
	}
	if !reflect.DeepEqual(*filters, []string{"fleet_a_results fleet-a.results.>"}) {
		t.Errorf("filters = %v", *filters)
	}
}

func TestWSSubscriptionsAndTableForSubject(t *testing.T) {
	tables := []TableInfo{
		{Name: "fleet-a", Prefix: "fleet-a"},
		{Name: "roundtable-dev", Prefix: "rt-dev"},
		{Name: "nested", Prefix: "rt-dev.sub"},
	}
	var subjects []string
	for _, s := range wsSubscriptions(tables) {
		subjects = append(subjects, s.subject+"/"+s.eventType)
	}
	want := []string{
		"fleet-a.tasks.>/task", "fleet-a.results.>/result",
		"rt-dev.tasks.>/task", "rt-dev.results.>/result",
		"rt-dev.sub.tasks.>/task", "rt-dev.sub.results.>/result",
	}
	if !reflect.DeepEqual(subjects, want) {
		t.Errorf("subscriptions = %v", subjects)
	}

	for subject, table := range map[string]string{
		"fleet-a.results.t1":       "fleet-a",
		"rt-dev.tasks.ui.t2":       "roundtable-dev",
		"rt-dev.sub.results.t3":    "nested", // longest prefix wins
		"fleet-ab.tasks.x.y":       "",
		"chelonian.results.whatev": "",
	} {
		got, ok := tableForSubject(tables, subject)
		if got.Name != table || ok != (table != "") {
			t.Errorf("%s: got %q ok=%v, want %q", subject, got.Name, ok, table)
		}
	}
}

func TestKnightStatusCarriesNATSPrefix(t *testing.T) {
	ks := buildKnightStatus(makeTableKnight("rt-ui", "ui", "rt-dev"), nil, nil)
	if ks.NATSPrefix != "rt-dev" {
		t.Errorf("natsPrefix = %q", ks.NATSPrefix)
	}
}
