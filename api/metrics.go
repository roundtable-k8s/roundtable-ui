package main

import (
	"log/slog"
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

	sseStreams = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "roundtable_ui_sse_streams",
		Help: "Open relayed SSE streams.",
	})

	sseRejectedTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "roundtable_ui_sse_rejected_total",
		Help: "SSE relays rejected because SSE_MAX_STREAMS was reached.",
	})

	httpRequestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "roundtable_ui_http_request_duration_seconds",
		Help:    "HTTP request latency, by route template and method.",
		Buckets: []float64{0.005, 0.025, 0.1, 0.5, 1, 5, 30},
	}, []string{"route", "method"})
)

var (
	gatewayRequestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "roundtable_ui_gateway_requests_total",
		Help: "Gateway relay calls, by route template, method and upstream status code (\"error\" when the transport failed).",
	}, []string{"route", "method", "code"})

	informerSyncFailuresTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "roundtable_ui_informer_sync_failures_total",
		Help: "Informer first-sync timeouts (resource) and watch errors (resource_watch), by resource.",
	}, []string{"resource"})

	natsDisconnectsTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "roundtable_ui_nats_disconnects_total",
		Help: "NATS disconnects.",
	})

	natsConnected = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "roundtable_ui_nats_connected",
		Help: "1 while the NATS connection is up, 0 otherwise.",
	})
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

// routeLabelKey carries a fixed route label for requests mux answers without
// a matched route (router-level 404/405).
type routeLabelKey struct{}

const notFoundRouteLabel = "not_found"

// routeLabel returns the mux route template (e.g. /api/fleet/{knight}) so
// metric cardinality stays bounded; non-API paths collapse to "static".
func routeLabel(r *http.Request) string {
	if l, ok := r.Context().Value(routeLabelKey{}).(string); ok {
		return l
	}
	if route := mux.CurrentRoute(r); route != nil {
		if tmpl, err := route.GetPathTemplate(); err == nil && tmpl != "/" {
			return tmpl
		}
	}
	return "static"
}

// slowRequestThreshold is the latency above which an access log line is
// written at warn level even when the response was successful.
var slowRequestThreshold = time.Second

func metricsMiddleware(next http.Handler) http.Handler {
	// LOG_REQUESTS=true also logs fast 2xx/3xx responses at info level.
	logAll, _ := strconv.ParseBool(envOr("LOG_REQUESTS", ""))
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
		elapsed := time.Since(start)
		route := routeLabel(r)
		httpRequestsTotal.WithLabelValues(route, r.Method, strconv.Itoa(sr.status)).Inc()
		httpRequestDuration.WithLabelValues(route, r.Method).Observe(elapsed.Seconds())
		if r.URL.Path != "/api/health" && r.URL.Path != "/metrics" {
			logAccess(r, route, sr.status, elapsed, logAll)
		}
	})
}

// logAccess writes one structured line per request. Only the route template
// is logged: never the raw path, query string, headers or body, so API keys
// and path ids cannot leak into logs.
func logAccess(r *http.Request, route string, status int, elapsed time.Duration, logAll bool) {
	level := slog.LevelInfo
	switch {
	case status >= http.StatusInternalServerError:
		level = slog.LevelError
	case status >= http.StatusBadRequest || elapsed >= slowRequestThreshold:
		level = slog.LevelWarn
	case !logAll:
		return
	}
	slog.LogAttrs(r.Context(), level, "http request",
		slog.String("method", r.Method),
		slog.String("route", route),
		slog.Int("status", status),
		slog.Float64("duration_ms", float64(elapsed)/float64(time.Millisecond)),
	)
}
