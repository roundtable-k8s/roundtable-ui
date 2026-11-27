package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace/noop"
)

func newTracedRouter(h http.HandlerFunc) *mux.Router {
	r := mux.NewRouter()
	r.Use(tracingMiddleware)
	r.HandleFunc("/api/fleet/{knight}", h).Methods("GET")
	r.HandleFunc("/api/ws", func(w http.ResponseWriter, _ *http.Request) {}).Methods("GET")
	r.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {}).Methods("GET")
	return r
}

func withRecorder(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	sr := tracetest.NewSpanRecorder()
	tp := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr))
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(tp)
	prevProp := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTracerProvider(prev); otel.SetTextMapPropagator(prevProp) })
	return sr
}

func TestSpanNameIsRouteTemplateAndTable(t *testing.T) {
	sr := withRecorder(t)
	r := newTracedRouter(func(w http.ResponseWriter, req *http.Request) {
		setSpanTable(req.Context(), "fleet-a")
	})
	for _, p := range []string{"/api/fleet/galahad", "/healthz", "/api/ws"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", p, nil))
	}
	spans := sr.Ended()
	if len(spans) != 1 {
		t.Fatalf("want 1 span (healthz and ws skipped), got %d", len(spans))
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

func newTracedGatewayRouter(g *gatewayClient) *mux.Router {
	r := mux.NewRouter()
	r.Use(tracingMiddleware)
	r.HandleFunc("/api/tasks/dispatch", func(w http.ResponseWriter, req *http.Request) {
		g.relay(w, req, http.MethodPost, "/v1/knights/galahad/invoke", nil, []byte(`{}`))
	}).Methods("POST")
	r.HandleFunc("/api/runs/{ns}/{run}/cancel", func(w http.ResponseWriter, req *http.Request) {
		g.relay(w, req, http.MethodPost, "/v1/runs/ns/run-SECRETID/cancel", url.Values{"table": {"SECRETQ"}}, []byte(`{}`))
	}).Methods("POST")
	r.HandleFunc("/api/chat/{taskId}/events", chatEventsHandler(g)).Methods("GET")
	return r
}

func traceparentGateway(t *testing.T, got *[]string) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*got = append(*got, r.Header.Get("traceparent"))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func serverTraceID(t *testing.T, sr *tracetest.SpanRecorder) string {
	for _, s := range sr.Ended() {
		if s.SpanKind().String() == "server" {
			return s.SpanContext().TraceID().String()
		}
	}
	t.Fatal("no server span recorded")
	return ""
}

func TestGatewayRelayPropagatesTraceparent(t *testing.T) {
	sr := withRecorder(t)
	var got []string
	gw := traceparentGateway(t, &got)
	g := &gatewayClient{baseURL: gw.URL, token: "secret-tok", http: newGatewayHTTPClient(http.DefaultTransport)}
	rec := httptest.NewRecorder()
	newTracedGatewayRouter(g).ServeHTTP(rec, httptest.NewRequest("POST", "/api/tasks/dispatch", nil))
	if len(got) != 1 || !strings.HasPrefix(got[0], "00-"+serverTraceID(t, sr)+"-") {
		t.Fatalf("traceparent = %v, want trace %s", got, serverTraceID(t, sr))
	}
	var client bool
	for _, s := range sr.Ended() {
		if s.SpanKind().String() != "client" {
			continue
		}
		client = true
		if s.Name() != "POST /v1/knights/{id}/invoke" {
			t.Errorf("client span name = %q", s.Name())
		}
		for _, a := range s.Attributes() {
			if strings.Contains(a.Value.Emit(), "secret-tok") {
				t.Errorf("token recorded in attribute %s", a.Key)
			}
		}
	}
	if !client {
		t.Error("no client span")
	}
}

func TestGatewayStreamPropagatesTraceparent(t *testing.T) {
	sr := withRecorder(t)
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("traceparent"))
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: x\n\n"))
	}))
	defer srv.Close()
	g := &gatewayClient{baseURL: srv.URL, http: newGatewayHTTPClient(http.DefaultTransport)}
	newTracedGatewayRouter(g).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/chat/t1/events", nil))
	if len(got) != 1 || !strings.HasPrefix(got[0], "00-"+serverTraceID(t, sr)+"-") {
		t.Fatalf("traceparent = %v", got)
	}
}

func TestGatewayNoProviderSendsNoTraceparent(t *testing.T) {
	prev := otel.GetTracerProvider()
	otel.SetTracerProvider(noop.NewTracerProvider())
	t.Cleanup(func() { otel.SetTracerProvider(prev) })
	var got []string
	gw := traceparentGateway(t, &got)
	g := &gatewayClient{baseURL: gw.URL, http: newGatewayHTTPClient(http.DefaultTransport)}
	g.relay(httptest.NewRecorder(), httptest.NewRequest("GET", "/x", nil), "GET", "/v1/knights", nil, nil)
	if len(got) != 1 || got[0] != "" {
		t.Errorf("traceparent = %v, want none", got)
	}
}

func TestRelayErrorLogCarriesTraceID(t *testing.T) {
	withRecorder(t)
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(newTraceHandler(slog.NewJSONHandler(&buf, nil))))
	t.Cleanup(func() { slog.SetDefault(prev) })
	g := &gatewayClient{baseURL: "http://127.0.0.1:1", http: newGatewayHTTPClient(http.DefaultTransport)}
	r := newTracedGatewayRouter(g)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("POST", "/api/tasks/dispatch", nil))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("code = %d", rec.Code)
	}
	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &line); err != nil {
		t.Fatalf("%v: %s", err, buf.String())
	}
	if id, _ := line["trace_id"].(string); len(id) != 32 {
		t.Errorf("trace_id = %v", line["trace_id"])
	}
}

func TestGatewayRouteTemplate(t *testing.T) {
	for in, want := range map[string]string{
		"/v1/knights":                               "/v1/knights",
		"/v1/tasks/abc/events":                      "/v1/tasks/{id}/events",
		"/v1/dead-letters/t1/retry":                 "/v1/dead-letters/{id}/retry",
		"/v1/runs/ns/run-1/cancel":                  "/v1/runs/{namespace}/{name}/cancel",
		"/v1/schedules/ns/s/runs/digest-1795600000": "/v1/schedules/{namespace}/{name}/runs/{id}",
		"/v1/schedules/ns/s/manifest":               "/v1/schedules/{namespace}/{name}/manifest",
		"/other/thing":                              "/",
	} {
		if got := gatewayRouteTemplate(in); got != want {
			t.Errorf("%s -> %s, want %s", in, got, want)
		}
	}
}

func assertNoSecrets(t *testing.T, sr *tracetest.SpanRecorder) {
	t.Helper()
	for _, s := range sr.Ended() {
		if s.SpanKind().String() != "client" {
			continue
		}
		all := s.Name()
		for _, a := range s.Attributes() {
			all += " " + string(a.Key) + "=" + a.Value.Emit()
		}
		for _, secret := range []string{"SECRETID", "SECRETQ", "secret-tok", "t-SECRET"} {
			if strings.Contains(all, secret) {
				t.Errorf("client span leaks %q: %s", secret, all)
			}
		}
	}
}

func TestGatewayClientSpanHidesIDs(t *testing.T) {
	sr := withRecorder(t)
	var got []string
	gw := traceparentGateway(t, &got)
	g := &gatewayClient{baseURL: gw.URL, token: "secret-tok", http: newGatewayHTTPClient(http.DefaultTransport)}
	r := newTracedGatewayRouter(g)
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/api/runs/ns/x/cancel", nil))
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/chat/t-SECRET/events", nil))
	assertNoSecrets(t, sr)
	found := false
	for _, s := range sr.Ended() {
		for _, a := range s.Attributes() {
			if a.Key == "url.full" && strings.HasSuffix(a.Value.AsString(), "/v1/runs/{namespace}/{name}/cancel") {
				found = true
			}
		}
	}
	if !found {
		t.Error("templated url.full not recorded")
	}
}

func TestServerSpanURLPathIsRouteTemplate(t *testing.T) {
	sr := withRecorder(t)
	r := mux.NewRouter()
	r.Use(tracingMiddleware)
	r.HandleFunc("/api/fleet/{knight}", func(http.ResponseWriter, *http.Request) {}).Methods("GET")
	r.HandleFunc("/api/chains/{name}/steps/{step}/output", func(http.ResponseWriter, *http.Request) {}).Methods("GET")
	const runID = "nightly-run-abc"
	for _, p := range []string{"/api/fleet/galahad", "/api/chains/" + runID + "/steps/build/output"} {
		r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", p, nil))
	}
	spans := sr.Ended()
	if len(spans) != 2 {
		t.Fatalf("want 2 spans, got %d", len(spans))
	}
	wantPath := map[string]string{
		"GET /api/fleet/{knight}":                    "/api/fleet/{knight}",
		"GET /api/chains/{name}/steps/{step}/output": "/api/chains/{name}/steps/{step}/output",
	}
	for _, s := range spans {
		want, ok := wantPath[s.Name()]
		if !ok {
			t.Fatalf("unexpected span name %q", s.Name())
		}
		var got string
		for _, a := range s.Attributes() {
			if strings.Contains(a.Value.Emit(), "galahad") || strings.Contains(a.Value.Emit(), runID) {
				t.Errorf("span %q attribute %s leaks a concrete id: %q", s.Name(), a.Key, a.Value.Emit())
			}
			if string(a.Key) == "url.path" {
				got = a.Value.AsString()
			}
		}
		if got != want {
			t.Errorf("span %q url.path = %q, want %q", s.Name(), got, want)
		}
	}
}
