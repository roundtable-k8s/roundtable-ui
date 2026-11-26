package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestMetricsEndpointServesInstrumentedRequests(t *testing.T) {
	r := mux.NewRouter()
	r.Use(metricsMiddleware)
	r.Handle("/metrics", promhttp.Handler()).Methods("GET")
	r.HandleFunc("/api/metrics-test/{id}", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusTeapot)
	}).Methods("GET")

	// One instrumented request, with a path variable that must not leak into labels.
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", "/api/metrics-test/abc123", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("instrumented request status = %d, want %d", rec.Code, http.StatusTeapot)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics status = %d, want 200", rec.Code)
	}
	body := rec.Body.String()

	for _, want := range []string{
		"# TYPE roundtable_ui_http_requests_total counter",
		"# TYPE roundtable_ui_http_request_duration_seconds histogram",
		`roundtable_ui_http_requests_total{code="418",method="GET",route="/api/metrics-test/{id}"} 1`,
		`roundtable_ui_http_request_duration_seconds_count{method="GET",route="/api/metrics-test/{id}"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics output missing %q", want)
		}
	}
	if strings.Contains(body, "abc123") {
		t.Error("raw path value leaked into metric labels")
	}
}

func TestMetricsMiddlewareDefaultsTo200AndStaticRoute(t *testing.T) {
	h := metricsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	before := counterValue(t, "static", "GET", "200")
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/index.html", nil))
	if got := counterValue(t, "static", "GET", "200") - before; got != 1 {
		t.Fatalf("static/200 counter delta = %v, want 1", got)
	}
}

// captureAccessLog routes the default slog logger to a buffer for one test and
// returns a function that decodes the access log lines written so far.
func captureAccessLog(t *testing.T) func() []map[string]any {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return func() []map[string]any {
		var out []map[string]any
		for _, raw := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
			if raw == "" {
				continue
			}
			var m map[string]any
			if err := json.Unmarshal([]byte(raw), &m); err != nil {
				t.Fatalf("log line is not JSON: %v: %s", err, raw)
			}
			if m["msg"] == "http request" {
				out = append(out, m)
			}
		}
		return out
	}
}

func accessLogRouter(status int) *mux.Router {
	r := mux.NewRouter()
	r.Use(metricsMiddleware)
	r.HandleFunc("/api/access-test/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
	}).Methods("GET")
	r.HandleFunc("/api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(status)
	}).Methods("GET")
	return r
}

func TestAccessLogLevelsByStatusAndLatency(t *testing.T) {
	t.Setenv("LOG_REQUESTS", "")
	prevThreshold := slowRequestThreshold
	t.Cleanup(func() { slowRequestThreshold = prevThreshold })

	tests := []struct {
		name      string
		status    int
		slow      bool
		wantLines int
		wantLevel string
	}{
		{name: "server error logs at error", status: http.StatusInternalServerError, wantLines: 1, wantLevel: "ERROR"},
		{name: "not found logs at warn", status: http.StatusNotFound, wantLines: 1, wantLevel: "WARN"},
		{name: "rate limited logs at warn", status: http.StatusTooManyRequests, wantLines: 1, wantLevel: "WARN"},
		{name: "fast success is silent by default", status: http.StatusOK, wantLines: 0},
		{name: "slow success logs at warn", status: http.StatusOK, slow: true, wantLines: 1, wantLevel: "WARN"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.slow {
				slowRequestThreshold = 0
			} else {
				slowRequestThreshold = time.Hour
			}
			lines := captureAccessLog(t)
			accessLogRouter(tt.status).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/access-test/abc123", nil))
			got := lines()
			if len(got) != tt.wantLines {
				t.Fatalf("access log lines = %d, want %d: %v", len(got), tt.wantLines, got)
			}
			if tt.wantLines == 0 {
				return
			}
			line := got[0]
			if line["level"] != tt.wantLevel {
				t.Errorf("level = %v, want %s", line["level"], tt.wantLevel)
			}
			if line["route"] != "/api/access-test/{id}" {
				t.Errorf("route = %v, want the route template", line["route"])
			}
			if line["status"] != float64(tt.status) {
				t.Errorf("status = %v, want %d", line["status"], tt.status)
			}
			if _, ok := line["duration_ms"].(float64); !ok {
				t.Errorf("duration_ms missing or not a number: %v", line["duration_ms"])
			}
			if line["method"] != "GET" {
				t.Errorf("method = %v, want GET", line["method"])
			}
		})
	}
}

func TestAccessLogInfoForFastSuccessWhenEnabled(t *testing.T) {
	t.Setenv("LOG_REQUESTS", "true")
	prevThreshold := slowRequestThreshold
	t.Cleanup(func() { slowRequestThreshold = prevThreshold })
	slowRequestThreshold = time.Hour

	lines := captureAccessLog(t)
	accessLogRouter(http.StatusOK).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/access-test/x", nil))
	got := lines()
	if len(got) != 1 || got[0]["level"] != "INFO" {
		t.Fatalf("access log = %v, want one INFO line", got)
	}
}

func TestAccessLogSkipsHealthAndMetrics(t *testing.T) {
	t.Setenv("LOG_REQUESTS", "true")
	r := accessLogRouter(http.StatusInternalServerError)
	r.Handle("/metrics", promhttp.Handler()).Methods("GET")
	lines := captureAccessLog(t)

	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/health", nil))
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/metrics", nil))
	if got := lines(); len(got) != 0 {
		t.Fatalf("health and metrics requests were logged: %v", got)
	}
}

func TestAccessLogOmitsQueryStringAndHeaders(t *testing.T) {
	t.Setenv("LOG_REQUESTS", "true")
	lines := captureAccessLog(t)

	// The probe value appears in the query and a header; neither may be logged.
	const probe = "ZQ-PROBE-7731"
	req := httptest.NewRequest("GET", "/api/access-test/abc123?q="+probe, nil)
	req.Header.Set("Authorization", "Basic "+probe)
	accessLogRouter(http.StatusUnauthorized).ServeHTTP(httptest.NewRecorder(), req)

	got := lines()
	if len(got) != 1 {
		t.Fatalf("access log lines = %d, want 1", len(got))
	}
	raw, _ := json.Marshal(got[0])
	for _, leak := range []string{probe, "abc123", "?q="} {
		if strings.Contains(string(raw), leak) {
			t.Errorf("access log leaked %q: %s", leak, raw)
		}
	}
}

func counterValue(t *testing.T, route, method, code string) float64 {
	t.Helper()
	c, err := httpRequestsTotal.GetMetricWithLabelValues(route, method, code)
	if err != nil {
		t.Fatal(err)
	}
	return testutil.ToFloat64(c)
}

func TestBuildInfoMetricLabels(t *testing.T) {
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(newBuildInfoCollector(versionInfo{Version: "v1", Commit: "abc", GoVersion: "go1.x"}))
	want := `# HELP roundtable_ui_build_info Build information of the running dashboard API; the value is always 1.
# TYPE roundtable_ui_build_info gauge
roundtable_ui_build_info{commit="abc",go_version="go1.x",version="v1"} 1
`
	if err := testutil.GatherAndCompare(reg, strings.NewReader(want), "roundtable_ui_build_info"); err != nil {
		t.Fatal(err)
	}
}

func TestRunningTasksMetric(t *testing.T) {
	r := newRunningRegistry(10, time.Second)
	r.tasks["a"] = &RunningTask{TaskID: "a", Status: "running"}
	r.tasks["b"] = &RunningTask{TaskID: "b", Status: "running"}
	r.tasks["c"] = &RunningTask{TaskID: "c", Status: "stale"}
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(runningTasksCollector{r})
	want := `# HELP roundtable_ui_running_tasks Tasks held by the in-flight registry, by status (running, stale, lost).
# TYPE roundtable_ui_running_tasks gauge
roundtable_ui_running_tasks{status="lost"} 0
roundtable_ui_running_tasks{status="running"} 2
roundtable_ui_running_tasks{status="stale"} 1
`
	if err := testutil.GatherAndCompare(reg, strings.NewReader(want), "roundtable_ui_running_tasks"); err != nil {
		t.Fatal(err)
	}
}

func TestListCacheMetrics(t *testing.T) {
	resetListCache() // drop informers leaked by other tests
	setupTriggerRouter(t,
		trigObj("a", map[string]interface{}{"nats": map[string]interface{}{"subject": "x"}}, nil),
		trigObj("b", map[string]interface{}{"nats": map[string]interface{}{"subject": "y"}}, nil))
	if _, err := cachedList(context.Background(), dynClient, triggerGVR, "roundtable"); err != nil {
		t.Fatal(err)
	}
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(listCacheCollector{})
	want := `# HELP roundtable_ui_list_cache_objects Objects held in a watch-backed list cache, by resource.
# TYPE roundtable_ui_list_cache_objects gauge
roundtable_ui_list_cache_objects{resource="triggers"} 2
# HELP roundtable_ui_list_cache_synced 1 when the watch-backed list cache of a resource has completed its first sync, else 0.
# TYPE roundtable_ui_list_cache_synced gauge
roundtable_ui_list_cache_synced{resource="triggers"} 1
`
	if err := testutil.GatherAndCompare(reg, strings.NewReader(want)); err != nil {
		t.Fatal(err)
	}
}

func TestChainWatchSubscribersMetric(t *testing.T) {
	c := newChainWatcher(nil, "roundtable", nil)
	reg := prometheus.NewPedanticRegistry()
	reg.MustRegister(newChainWatchSubscribersGauge(c))
	count := func() float64 {
		mfs, err := reg.Gather()
		if err != nil || len(mfs) != 1 {
			t.Fatalf("gather: %v %d", err, len(mfs))
		}
		return mfs[0].GetMetric()[0].GetGauge().GetValue()
	}
	if got := count(); got != 0 {
		t.Fatalf("got %v want 0", got)
	}
	un := c.subscribe(func([]byte) {})
	if got := count(); got != 1 {
		t.Fatalf("got %v want 1", got)
	}
	un()
	if got := count(); got != 0 {
		t.Fatalf("got %v want 0", got)
	}
}

func relayOnce(t *testing.T, g *gatewayClient) {
	t.Helper()
	r := mux.NewRouter()
	r.HandleFunc("/api/relay-test/{id}", func(w http.ResponseWriter, r *http.Request) {
		g.relay(w, r, http.MethodGet, "/v1/x", nil, nil)
	}).Methods("GET")
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/relay-test/abc", nil))
}

func TestGatewayRequestsMetric(t *testing.T) {
	const route = "/api/relay-test/{id}"
	count := func(code string) float64 {
		return testutil.ToFloat64(gatewayRequestsTotal.WithLabelValues(route, "GET", code))
	}
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("{}")) }))
	defer ok.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) }))
	defer bad.Close()
	closed := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closedURL := closed.URL
	closed.Close()

	for _, tc := range []struct{ code, url string }{{"200", ok.URL}, {"500", bad.URL}, {"error", closedURL}} {
		before := count(tc.code)
		relayOnce(t, &gatewayClient{baseURL: tc.url, http: &http.Client{}})
		if got := count(tc.code) - before; got != 1 {
			t.Errorf("code=%s: counter delta = %v, want 1", tc.code, got)
		}
	}
}

func TestNATSMetricsRegistered(t *testing.T) {
	natsConnected.Set(1)
	if got := testutil.ToFloat64(natsConnected); got != 1 {
		t.Errorf("natsConnected = %v, want 1", got)
	}
	before := testutil.ToFloat64(natsDisconnectsTotal)
	natsDisconnectsTotal.Inc()
	if got := testutil.ToFloat64(natsDisconnectsTotal) - before; got != 1 {
		t.Errorf("disconnects delta = %v, want 1", got)
	}
}
