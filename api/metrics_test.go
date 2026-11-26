package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

func counterValue(t *testing.T, route, method, code string) float64 {
	t.Helper()
	c, err := httpRequestsTotal.GetMetricWithLabelValues(route, method, code)
	if err != nil {
		t.Fatal(err)
	}
	return testutil.ToFloat64(c)
}
