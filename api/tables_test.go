package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/nats-io/nats.go/jetstream"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	clienttesting "k8s.io/client-go/testing"
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
	resetTaskHistory()
	t.Cleanup(func() { readResults = old; resetTaskHistory() })
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

func TestTablesHandler(t *testing.T) {
	withTwoTables(t)
	r := mux.NewRouter()
	r.HandleFunc("/api/tables", tablesHandler(newTableSource(tablesTestNS, "", ""))).Methods("GET")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/tables", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	var resp struct{ Tables []TableInfo }
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Tables) != 2 || resp.Tables[0].Name != "fleet-a" {
		t.Errorf("tables = %+v", resp.Tables)
	}
}

func TestTablesStaleCacheDoesNotWaitForSlowDiscovery(t *testing.T) {
	withTwoTables(t)
	now := time.Now()
	src := newTableSource(tablesTestNS, "", "")
	src.now = func() time.Time { return now }
	first := src.tables(context.Background()) // warm the cache

	// Make the cache stale and block the next list on the API server.
	release := make(chan struct{})
	started := make(chan struct{})
	dynClient.(*fake.FakeDynamicClient).PrependReactor("list", "roundtables",
		func(k2 clienttesting.Action) (bool, runtime.Object, error) {
			close(started)
			<-release
			return false, nil, nil
		})
	now = now.Add(2 * src.ttl)

	done := make(chan []TableInfo)
	go func() { done <- src.tables(context.Background()) }() // runs the slow refresh
	<-started

	got := make(chan []TableInfo, 1)
	go func() { got <- src.tables(context.Background()) }()
	select {
	case g := <-got:
		if !reflect.DeepEqual(g, first) {
			t.Errorf("got %+v, want cached %+v", g, first)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("second caller blocked behind slow discovery")
	}
	close(release)
	<-done
}

func TestTablesColdStartSurvivesLeaderDisconnect(t *testing.T) {
	withTwoTables(t)
	src := newTableSource(tablesTestNS, "", "")
	var discoverCtxErr error
	discover := src.discover
	src.discoverFn = func(ctx context.Context) ([]TableInfo, error) {
		discoverCtxErr = ctx.Err()
		return discover(ctx)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the leader's client is already gone
	got := src.tables(ctx)
	if discoverCtxErr != nil {
		t.Fatalf("discover received a cancelled context: %v", discoverCtxErr)
	}
	if len(got) != 2 {
		t.Fatalf("got %+v, want the two discovered tables", got)
	}
	if !src.hasCache() {
		t.Fatal("discovery should have succeeded and been cached")
	}
}

func TestTablesPanickingDiscoveryReleasesWaiters(t *testing.T) {
	withTwoTables(t)
	release := make(chan struct{})
	started := make(chan struct{})
	var panicked atomic.Bool
	dynClient.(*fake.FakeDynamicClient).PrependReactor("list", "roundtables",
		func(clienttesting.Action) (bool, runtime.Object, error) {
			if !panicked.CompareAndSwap(false, true) {
				return false, nil, nil // later discoveries use the fake data
			}
			close(started)
			<-release
			panic("boom")
		})
	src := newTableSource(tablesTestNS, "fallback", "")

	leaderDone := make(chan any, 1)
	go func() {
		defer func() { leaderDone <- recover() }()
		src.tables(context.Background())
	}()
	<-started

	waiter := make(chan []TableInfo, 1)
	go func() { waiter <- src.tables(context.Background()) }()
	close(release) // the leader panics; the waiter must not stay blocked

	if r := <-leaderDone; r == nil {
		t.Fatal("expected the leader to panic")
	}
	select {
	case got := <-waiter:
		if len(got) == 0 {
			t.Fatal("waiter got no tables")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("waiter still blocked after the discovery panicked")
	}
	src.mu.Lock()
	defer src.mu.Unlock()
	if src.inflight != nil {
		t.Fatal("inflight not cleared after panic")
	}
}

func resetTaskHistory() {
	taskHistory.mu.Lock()
	taskHistory.entries = map[string]historyEntry{}
	taskHistory.mu.Unlock()
}

// fakeStream records calls and serves messages by sequence.
type fakeStream struct {
	mu        sync.Mutex
	msgs      map[uint64]*jetstream.RawStreamMsg // missing seq = deleted
	last      uint64
	getErr    error
	consumers int
	deleted   int
	gets      int
}

func (f *fakeStream) Info(context.Context, ...jetstream.StreamInfoOpt) (*jetstream.StreamInfo, error) {
	return &jetstream.StreamInfo{State: jetstream.StreamState{FirstSeq: 1, LastSeq: f.last, Msgs: uint64(len(f.msgs))}}, nil
}

func (f *fakeStream) GetMsg(_ context.Context, seq uint64, _ ...jetstream.GetMsgOpt) (*jetstream.RawStreamMsg, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gets++
	if f.getErr != nil {
		return nil, f.getErr
	}
	if m, ok := f.msgs[seq]; ok {
		return m, nil
	}
	return nil, jetstream.ErrMsgNotFound
}

func (f *fakeStream) CreateOrUpdateConsumer(context.Context, jetstream.ConsumerConfig) (jetstream.Consumer, error) {
	f.mu.Lock()
	f.consumers++
	f.mu.Unlock()
	return nil, errors.New("consumer creation not expected")
}

func (f *fakeStream) DeleteConsumer(context.Context, string) error {
	f.mu.Lock()
	f.deleted++
	f.mu.Unlock()
	return nil
}

func newFakeStream(n int) *fakeStream {
	f := &fakeStream{msgs: map[uint64]*jetstream.RawStreamMsg{}, last: uint64(n)}
	for i := 1; i <= n; i++ {
		f.msgs[uint64(i)] = &jetstream.RawStreamMsg{Subject: fmt.Sprintf("rt.results.t%d", i), Sequence: uint64(i), Data: []byte(`{}`)}
	}
	return f
}

func TestReadNewestResultsDirectGet(t *testing.T) {
	f := newFakeStream(10)
	delete(f.msgs, 9)                     // deleted
	f.msgs[8].Subject = "other.results.x" // other subject
	evs, total, err := readNewestResults(context.Background(), f, "rt.results.>", 3)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, e := range evs {
		got = append(got, e.Subject)
	}
	want := []string{"rt.results.t6", "rt.results.t7", "rt.results.t10"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
	if total != 9 {
		t.Errorf("total = %d", total)
	}
	if f.consumers != 0 {
		t.Errorf("consumers created: %d", f.consumers)
	}
}

func TestReadNewestResultsLookupCap(t *testing.T) {
	f := newFakeStream(100)
	for i := 1; i <= 100; i++ {
		f.msgs[uint64(i)].Subject = "other.x"
	}
	evs, _, err := readNewestResults(context.Background(), f, "rt.results.>", 5)
	if err != nil || len(evs) != 0 {
		t.Fatalf("evs=%v err=%v", evs, err)
	}
	if f.gets != 10 {
		t.Errorf("lookups = %d, want 10", f.gets)
	}
}

func TestReadNewestResultsFallbackUsesConsumer(t *testing.T) {
	f := newFakeStream(3)
	f.getErr = errors.New("direct get not allowed")
	evs, total, err := readNewestResults(context.Background(), f, "rt.results.>", 3)
	if err != nil || len(evs) != 0 || total != 3 {
		t.Fatalf("evs=%v total=%d err=%v", evs, total, err)
	}
	if f.consumers != 1 {
		t.Errorf("fallback consumers = %d, want 1", f.consumers)
	}
}

func TestTaskHistoryCacheSingleRead(t *testing.T) {
	resetTaskHistory()
	t.Cleanup(resetTaskHistory)
	old := readResults
	t.Cleanup(func() { readResults = old })
	var reads atomic.Int32
	release := make(chan struct{})
	readResults = func(context.Context, string, string, int) ([]TaskEvent, uint64, error) {
		reads.Add(1)
		<-release
		return []TaskEvent{{Subject: "a"}}, 1, nil
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			evs, _, err := taskHistory.get(context.Background(), "s", "f", 50)
			if err != nil || len(evs) != 1 {
				t.Errorf("evs=%v err=%v", evs, err)
			}
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()
	if _, _, err := taskHistory.get(context.Background(), "s", "f", 50); err != nil {
		t.Fatal(err)
	}
	if n := reads.Load(); n != 1 {
		t.Errorf("reads = %d, want 1", n)
	}
}

func TestTaskHistoryCacheDoesNotCacheErrors(t *testing.T) {
	resetTaskHistory()
	t.Cleanup(resetTaskHistory)
	old := readResults
	t.Cleanup(func() { readResults = old })
	var reads int
	readResults = func(context.Context, string, string, int) ([]TaskEvent, uint64, error) {
		reads++
		if reads == 1 {
			return nil, 0, errors.New("boom")
		}
		return []TaskEvent{{Subject: "a"}}, 1, nil
	}
	if _, _, err := taskHistory.get(context.Background(), "s", "f", 50); err == nil {
		t.Fatal("want error")
	}
	if evs, _, err := taskHistory.get(context.Background(), "s", "f", 50); err != nil || len(evs) != 1 {
		t.Fatalf("evs=%v err=%v", evs, err)
	}
}
