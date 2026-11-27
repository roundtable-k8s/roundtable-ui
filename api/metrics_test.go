package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
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
