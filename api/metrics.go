package main

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	httpRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "roundtable_ui_http_requests_total",
		Help: "HTTP requests served, by route template, method, and status code.",
	}, []string{"route", "method", "code"})

	wsConnections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "roundtable_ui_ws_connections",
		Help: "Open WebSocket connections.",
	})

	wsRejectedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "roundtable_ui_ws_rejected_total",
		Help: "WebSocket connections rejected because WS_MAX_CONNECTIONS was reached.",
	})

	httpRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "roundtable_ui_http_request_duration_seconds",
		Help:    "HTTP request latency, by route template and method.",
		Buckets: []float64{0.005, 0.025, 0.1, 0.5, 1, 5, 30},
	}, []string{"route", "method"})
)

// statusRecorder captures the response status code for metrics labels.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (sr *statusRecorder) WriteHeader(code int) {
	sr.status = code
	sr.ResponseWriter.WriteHeader(code)
}

// Flush lets streaming handlers (SSE) flush through the wrapper.
func (sr *statusRecorder) Flush() {
	if f, ok := sr.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap exposes the underlying writer to http.ResponseController.
func (sr *statusRecorder) Unwrap() http.ResponseWriter { return sr.ResponseWriter }

// routeLabel returns the mux route template (e.g. /api/fleet/{knight}) so
// metric cardinality stays bounded; non-API paths collapse to "static".
func routeLabel(r *http.Request) string {
	if route := mux.CurrentRoute(r); route != nil {
		if tmpl, err := route.GetPathTemplate(); err == nil && tmpl != "/" {
			return tmpl
		}
	}
	return "static"
}

func metricsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// WebSocket connections hijack the ResponseWriter; wrapping it would
		// break the upgrade (statusRecorder doesn't implement http.Hijacker).
		if r.URL.Path == "/api/ws" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sr := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sr, r)
		route := routeLabel(r)
		httpRequestsTotal.WithLabelValues(route, r.Method, strconv.Itoa(sr.status)).Inc()
		httpRequestDuration.WithLabelValues(route, r.Method).Observe(time.Since(start).Seconds())
	})
}
