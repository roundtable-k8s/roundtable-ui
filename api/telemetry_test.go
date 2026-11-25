package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func newTracedRouter(h http.HandlerFunc) *mux.Router {
	r := mux.NewRouter()
	r.Use(tracingMiddleware)
	r.HandleFunc("/api/fleet/{knight}", h).Methods("GET")
	r.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {}).Methods("GET")
	return r
}

func withRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	t.Cleanup(func() { otel.SetTracerProvider(prev) })
	return sr
}

func TestSpanNameIsRouteTemplateAndTable(t *testing.T) {
	sr := withRecorder(t)
	r := newTracedRouter(func(w http.ResponseWriter, req *http.Request) {
		setSpanTable(req.Context(), "fleet-a")
	})
	for _, p := range []string{"/api/fleet/galahad", "/healthz"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", p, nil))
	}
	spans := sr.Ended()
	if len(spans) != 1 {
		t.Fatalf("want 1 span (healthz skipped), got %d", len(spans))
	}
	if got := spans[0].Name(); got != "GET /api/fleet/{knight}" {
		t.Errorf("span name = %q", got)
	}
	found := false
	for _, a := range spans[0].Attributes() {
		if string(a.Key) == "roundtable.table" && a.Value.AsString() == "fleet-a" {
			found = true
		}
	}
	if !found {
		t.Error("roundtable.table attribute missing")
	}
}

func TestSetupTelemetryDisabledWithoutEndpoint(t *testing.T) {
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "")
	t.Setenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "")
	if telemetryEnabled() {
		t.Fatal("telemetry must be off without an endpoint")
	}
	shutdown, err := setupTelemetry(context.Background())
	if err != nil || shutdown == nil {
		t.Fatalf("setup: %v", err)
	}
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, ok := otel.GetTracerProvider().(*sdktrace.TracerProvider); ok {
		t.Error("an SDK provider was installed without an endpoint")
	}
	t.Setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
	t.Setenv("OTEL_SDK_DISABLED", "true")
	if telemetryEnabled() {
		t.Error("OTEL_SDK_DISABLED must win")
	}
}

func TestLogLineCarriesTraceID(t *testing.T) {
	withRecorder(t)
	var buf bytes.Buffer
	logger := slog.New(newTraceHandler(slog.NewJSONHandler(&buf, nil)))
	r := newTracedRouter(func(w http.ResponseWriter, req *http.Request) {
		logger.InfoContext(req.Context(), "inside")
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/fleet/x", nil))
	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatal(err)
	}
	if id, _ := line["trace_id"].(string); len(id) != 32 {
		t.Errorf("trace_id = %v", line["trace_id"])
	}
	if _, ok := line["span_id"]; !ok {
		t.Error("span_id missing")
	}
	buf.Reset()
	logger.Info("outside")
	if bytes.Contains(buf.Bytes(), []byte("trace_id")) {
		t.Error("trace_id must be absent without a span")
	}
}
