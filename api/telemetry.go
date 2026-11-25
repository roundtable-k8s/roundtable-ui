package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

const defaultServiceName = "roundtable-ui"

// tableAttrKey is the span attribute naming the RoundTable a route is about.
const tableAttrKey = "roundtable.table"

// telemetryEnabled reports whether a trace exporter should be installed, from
// the standard OTEL_* env: nothing happens without an OTLP endpoint.
func telemetryEnabled() bool {
	if strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") {
		return false
	}
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_TRACES_EXPORTER")), "none") {
		return false
	}
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") != ""
}

// setupTelemetry installs the global tracer provider when the OTEL_* env asks
// for it and returns a shutdown func (always non-nil). Without an endpoint no
// exporter is created and no collector connection is attempted.
func setupTelemetry(ctx context.Context) (func(context.Context) error, error) {
	noop := func(context.Context) error { return nil }
	if !telemetryEnabled() {
		return noop, nil
	}
	exp, err := otlptracehttp.New(ctx)
	if err != nil {
		return noop, err
	}
	shutdown := installTracerProvider(exp)
	return shutdown, nil
}

// installTracerProvider registers a provider batching to exp.
func installTracerProvider(exp sdktrace.SpanExporter, opts ...sdktrace.TracerProviderOption) func(context.Context) error {
	name := os.Getenv("OTEL_SERVICE_NAME")
	if name == "" {
		name = defaultServiceName
	}
	res, err := resource.Merge(resource.Default(), resource.NewSchemaless(semconv.ServiceName(name)))
	if err != nil {
		res = resource.Default()
	}
	all := append([]sdktrace.TracerProviderOption{sdktrace.WithBatcher(exp), sdktrace.WithResource(res)}, opts...)
	tp := sdktrace.NewTracerProvider(all...)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
	return tp.Shutdown
}

// otelSkipPath lists endpoints that never produce spans.
func otelSkipPath(p string) bool {
	return p == "/healthz" || p == "/readyz" || p == "/metrics"
}

// tracingMiddleware starts a server span per request, named by mux route
// template (never the raw path). Install it with Router.Use so the route is
// already matched.
func tracingMiddleware(next http.Handler) http.Handler {
	return otelhttp.NewHandler(next, "http.server",
		otelhttp.WithFilter(func(r *http.Request) bool { return !otelSkipPath(r.URL.Path) }),
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
			return r.Method + " " + routeLabel(r)
		}),
		otelhttp.WithMetricAttributesFn(func(r *http.Request) []attribute.KeyValue {
			return []attribute.KeyValue{attribute.String("http.route", routeLabel(r))}
		}),
	)
}

// setSpanTable records the RoundTable a request is about on the server span.
// No-op for an empty table or when no span is recording.
func setSpanTable(ctx context.Context, table string) {
	if table == "" {
		return
	}
	if span := trace.SpanFromContext(ctx); span.IsRecording() {
		span.SetAttributes(attribute.String(tableAttrKey, table))
	}
}

// traceHandler wraps a slog.Handler adding trace_id and span_id when the
// context carries a recording span.
type traceHandler struct{ slog.Handler }

func newTraceHandler(h slog.Handler) slog.Handler { return traceHandler{h} }

func (h traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() && trace.SpanFromContext(ctx).IsRecording() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()), slog.String("span_id", sc.SpanID().String()))
	}
	return h.Handler.Handle(ctx, r)
}

func (h traceHandler) WithAttrs(a []slog.Attr) slog.Handler {
	return traceHandler{h.Handler.WithAttrs(a)}
}

func (h traceHandler) WithGroup(n string) slog.Handler { return traceHandler{h.Handler.WithGroup(n)} }
