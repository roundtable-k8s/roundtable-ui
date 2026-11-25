package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// seedChainFleet creates the three template fixtures plus `copies` finished
// run copies of pr-pipeline (from run-copy.json) and `running` running ones,
// like the live fleet with hundreds of issue-pickup copies.
func seedChainFleet(t *testing.T, copies, running int) {
	t.Helper()
	setupTestRouter()
	create := func(obj map[string]interface{}) {
		if _, err := dynClient.Resource(chainGVR).Namespace("roundtable").Create(context.Background(),
			&unstructured.Unstructured{Object: obj}, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{"fanout.json", "pr-pipeline-loop.json", "cost.json"} {
		create(loadChainFixture(t, f))
	}
	base := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < copies+running; i++ {
		obj := loadChainFixture(t, "run-copy.json")
		md := obj["metadata"].(map[string]interface{})
		md["name"] = fmt.Sprintf("pr-pipeline-roundtable-%03d", i)
		status := obj["status"].(map[string]interface{})
		status["startedAt"] = base.Add(time.Duration(i) * time.Hour).Format(time.RFC3339)
		switch {
		case i >= copies:
			status["phase"] = "Running"
			delete(status, "completedAt")
		case i%50 == 7:
			status["phase"] = "Failed"
		case i%50 == 9:
			status["phase"] = "PartiallySucceeded"
		}
		create(obj)
	}
}

func chainListRouter() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/api/chains", chainsHandler("roundtable", nil))
	r.HandleFunc("/api/chain-groups", chainGroupsHandler("roundtable"))
	return r
}

func getChains(t *testing.T, r *mux.Router, path string) ([]ChainSummary, *httptest.ResponseRecorder) {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("%s: status %d: %s", path, w.Code, w.Body.String())
	}
	var list []ChainSummary
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return list, w
}

func names(list []ChainSummary) []string {
	out := make([]string, len(list))
	for i, c := range list {
		out[i] = c.Name
	}
	return out
}

func TestParseChainResource_RunTemplate(t *testing.T) {
	c := parseChainResource(loadChainFixture(t, "run-copy.json"), nil)
	if c.RunTemplate != "pr-pipeline" {
		t.Errorf("runTemplate = %q", c.RunTemplate)
	}
	if c := parseChainResource(loadChainFixture(t, "cost.json"), nil); c.RunTemplate != "" {
		t.Errorf("template chain has runTemplate %q", c.RunTemplate)
	}
}

func TestChainsHandler_DefaultIsSlimPagedNewestFirst(t *testing.T) {
	seedChainFleet(t, 160, 2)
	r := chainListRouter()
	list, w := getChains(t, r, "/api/chains")

	if got := w.Header().Get("X-Total-Count"); got != "165" {
		t.Errorf("X-Total-Count = %q, want 165", got)
	}
	if len(list) != defaultChainListLimit {
		t.Fatalf("len = %d, want %d", len(list), defaultChainListLimit)
	}
	t.Logf("default page: %d bytes", w.Body.Len())
	if size := w.Body.Len(); size >= 100*1024 {
		t.Errorf("default page is %d bytes, want < 100 KB", size)
	}

	// Running first (the fanout and loop fixtures and two copies), then
	// newest first.
	running := 0
	for _, c := range list {
		if isChainRunning(c.Phase) {
			running++
		}
	}
	if running != 4 {
		t.Fatalf("running chains on page = %d, want 4", running)
	}
	for i, c := range list[:4] {
		if !isChainRunning(c.Phase) {
			t.Errorf("list[%d] = %s (%s), want a running chain first", i, c.Name, c.Phase)
		}
	}
	if got := names(list[:4]); !reflect.DeepEqual(got, []string{"fanout-scan", "pr-pipeline-roundtable-ui-187", "pr-pipeline-roundtable-161", "pr-pipeline-roundtable-160"}) {
		t.Errorf("running chains = %v", got)
	}
	for i := 5; i < len(list); i++ {
		if strOrEmpty(list[i-1].StartTime) < strOrEmpty(list[i].StartTime) {
			t.Fatalf("not newest first at %d: %v < %v", i, *list[i-1].StartTime, *list[i].StartTime)
		}
	}

	// Slim: chain-level phase, timings, cost and tokens; steps reduced to
	// name and phase.
	for _, c := range list {
		if !c.Slim {
			t.Errorf("%s: slim not set", c.Name)
		}
	}
	cp := list[5] // after the 4 running chains and cost-run (2026-11-24)
	if cp.RunTemplate != "pr-pipeline" || cp.StartTime == nil || cp.CompletionTime == nil || cp.CostUSD == "" || cp.Tokens == nil {
		t.Errorf("copy summary lost fields: %+v", cp)
	}
	if got := stepByName(t, cp, "implement"); !reflect.DeepEqual(got, StepSummary{Name: "implement", Phase: "Succeeded"}) {
		t.Errorf("slim step = %+v", got)
	}
	for _, field := range []string{`"result"`, `"output":"`, `"knight"`, `"dependsOn"`, `"taskId"`, `"fanOut"`, `"loop"`} {
		if strings.Contains(w.Body.String(), field) {
			t.Errorf("slim list contains %s", field)
		}
	}
}

func TestChainsHandler_Pagination(t *testing.T) {
	seedChainFleet(t, 30, 0)
	r := chainListRouter()
	all, _ := getChains(t, r, "/api/chains?limit=500")
	if len(all) != 33 {
		t.Fatalf("len = %d", len(all))
	}
	p1, w := getChains(t, r, "/api/chains?limit=10")
	p2, _ := getChains(t, r, "/api/chains?limit=10&offset=10")
	tail, _ := getChains(t, r, "/api/chains?limit=10&offset=30")
	past, w2 := getChains(t, r, "/api/chains?offset=40")
	if w.Header().Get("X-Total-Count") != "33" || w2.Header().Get("X-Total-Count") != "33" {
		t.Errorf("total = %q / %q", w.Header().Get("X-Total-Count"), w2.Header().Get("X-Total-Count"))
	}
	if !reflect.DeepEqual(names(p1), names(all[:10])) || !reflect.DeepEqual(names(p2), names(all[10:20])) {
		t.Errorf("pages do not tile the list")
	}
	if !reflect.DeepEqual(names(tail), names(all[30:])) {
		t.Errorf("tail = %v", names(tail))
	}
	if len(past) != 0 {
		t.Errorf("offset past the end = %v", names(past))
	}

	// limit is capped at 500.
	lq, msg := parseChainListQuery(map[string][]string{"limit": {"9999"}})
	if msg != "" || lq.limit != maxChainListLimit {
		t.Errorf("limit cap: %d %q", lq.limit, msg)
	}

	for _, q := range []string{"limit=0", "limit=x", "offset=-1", "full=maybe", "copies=some", "template=a/b"} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/chains?"+q, nil))
		if w.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d", q, w.Code)
		}
	}
}

func TestChainsHandler_Filters(t *testing.T) {
	seedChainFleet(t, 100, 1)
	r := chainListRouter()

	failed, w := getChains(t, r, "/api/chains?phase=failed")
	if w.Header().Get("X-Total-Count") != "2" || len(failed) != 2 {
		t.Errorf("phase=failed: %v (total %s)", names(failed), w.Header().Get("X-Total-Count"))
	}
	for _, c := range failed {
		if c.Phase != "Failed" {
			t.Errorf("phase filter let %s (%s) through", c.Name, c.Phase)
		}
	}

	multi, _ := getChains(t, r, "/api/chains?phase=Running,%20PartiallySucceeded")
	phases := map[string]int{}
	for _, c := range multi {
		phases[c.Phase]++
	}
	if len(phases) != 2 || phases["Running"] != 3 || phases["PartiallySucceeded"] != 2 {
		t.Errorf("phase=Running,PartiallySucceeded: %v", phases)
	}

	copies, w := getChains(t, r, "/api/chains?template=pr-pipeline&limit=20")
	if w.Header().Get("X-Total-Count") != "101" || len(copies) != 20 {
		t.Errorf("template filter: %d (total %s)", len(copies), w.Header().Get("X-Total-Count"))
	}
	if copies[0].Name != "pr-pipeline-roundtable-100" || !isChainRunning(copies[0].Phase) {
		t.Errorf("running copy not first: %s", copies[0].Name)
	}
	for _, c := range copies {
		if c.RunTemplate != "pr-pipeline" {
			t.Errorf("template filter let %s through", c.Name)
		}
	}
	if none, _ := getChains(t, r, "/api/chains?template=other"); len(none) != 0 {
		t.Errorf("template=other: %v", names(none))
	}

	tops, w := getChains(t, r, "/api/chains?copies=exclude")
	if w.Header().Get("X-Total-Count") != "3" || len(tops) != 3 {
		t.Errorf("copies=exclude: %v", names(tops))
	}
	only, w := getChains(t, r, "/api/chains?copies=only&limit=1")
	if w.Header().Get("X-Total-Count") != "101" || only[0].RunTemplate == "" {
		t.Errorf("copies=only: %v (total %s)", names(only), w.Header().Get("X-Total-Count"))
	}
}

func TestChainsHandler_FullKeepsOldPayload(t *testing.T) {
	seedChainFleet(t, 120, 1)
	r := chainListRouter()
	full, w := getChains(t, r, "/api/chains?full=true")
	if len(full) != 124 || w.Header().Get("X-Total-Count") != "124" {
		t.Fatalf("full: len %d total %s", len(full), w.Header().Get("X-Total-Count"))
	}

	// Equal to the pre-#275 handler: every chain parsed in list order.
	list, err := dynClient.Resource(chainGVR).Namespace("roundtable").List(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	want := []ChainSummary{}
	for _, item := range list.Items {
		want = append(want, parseChainResource(item.Object, map[string]knightInfo{}))
	}
	wantJSON, _ := json.Marshal(want)
	if got := strings.TrimSpace(w.Body.String()); got != string(wantJSON) {
		t.Errorf("full payload differs from the old one")
	}
	if !strings.Contains(w.Body.String(), `"result":"Opened https://github.com`) {
		t.Errorf("full payload has no step results")
	}
	if strings.Contains(w.Body.String(), `"slim"`) {
		t.Errorf("full payload marked slim")
	}

	// full=true with paging: paged and sorted, results kept.
	page, _ := getChains(t, r, "/api/chains?full=true&limit=5")
	if len(page) != 5 || page[0].Slim || stepByName(t, page[2], "plan").Result == nil {
		t.Errorf("full page: %v", names(page))
	}
}

func TestSlimChainKeepsInput(t *testing.T) {
	c := parseChainResource(loadChainFixture(t, "fanout.json"), nil)
	item := slimChain(c)
	if len(item.Steps) != len(c.Steps) || item.ChainSummary.Steps != nil || !item.Slim {
		t.Errorf("slim item = %+v", item)
	}
	// The source summary is untouched.
	if c.Slim || stepByName(t, c, "scan").FanOut == nil {
		t.Errorf("slimChain mutated its input")
	}
}

func TestChainGroupsHandler(t *testing.T) {
	seedChainFleet(t, 150, 1)
	r := chainListRouter()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/chain-groups", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var groups []ChainRunGroup
	if err := json.Unmarshal(w.Body.Bytes(), &groups); err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 {
		t.Fatalf("groups = %+v", groups)
	}
	g := groups[0]
	if g.Template != "pr-pipeline" || g.Runs != 151 || g.TemplateExists {
		t.Errorf("group = %+v", g)
	}
	if g.Phases["Running"] != 1 || g.Phases["Failed"] != 3 || g.Phases["PartiallySucceeded"] != 3 || g.Phases["Succeeded"] != 144 {
		t.Errorf("phases = %v", g.Phases)
	}
	if g.LastStartTime == nil || *g.LastStartTime != time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).Add(150*time.Hour).Format(time.RFC3339) {
		t.Errorf("lastStartTime = %v", g.LastStartTime)
	}
}

func TestChainRunGroupsOrder(t *testing.T) {
	ts := func(s string) *string { return &s }
	groups := chainRunGroups([]ChainSummary{
		{Name: "a"},
		{Name: "a-1", RunTemplate: "a", Phase: "Succeeded", StartTime: ts("2026-11-20T00:00:00Z")},
		{Name: "b-1", RunTemplate: "b", Phase: "Succeeded", StartTime: ts("2026-11-24T00:00:00Z")},
		{Name: "c-1", RunTemplate: "c", Phase: "Running", StartTime: ts("2026-11-01T00:00:00Z")},
		{Name: "c-2", RunTemplate: "c"},
	})
	got := []string{}
	for _, g := range groups {
		got = append(got, g.Template+":"+strconv.Itoa(g.Runs))
	}
	if !reflect.DeepEqual(got, []string{"c:2", "b:1", "a:1"}) {
		t.Errorf("order = %v", got)
	}
	if !groups[2].TemplateExists || groups[0].Phases["Pending"] != 1 {
		t.Errorf("groups = %+v", groups)
	}
}
