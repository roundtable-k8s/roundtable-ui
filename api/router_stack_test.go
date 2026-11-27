package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// stackRouter builds the router with main()'s middleware stack.
func stackRouter(t *testing.T) *mux.Router {
	t.Helper()
	t.Setenv("DASHBOARD_API_KEY", "secret")
	return buildRouter(routerDeps{
		namespace:     "test-namespace",
		gateway:       &gatewayClient{http: http.DefaultClient},
		dispatchLimit: newDispatchLimiter(),
		middleware: []mux.MiddlewareFunc{
			tracingMiddleware, securityHeaders, metricsMiddleware, authMiddleware,
			newRateLimiter(1000, 1e9).middleware,
		},
	})
}

func serveAs(r http.Handler, method, path string, auth bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if auth {
		req.Header.Set("Authorization", "Bearer secret")
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestRouterNotFoundThroughMiddleware(t *testing.T) {
	r := stackRouter(t)
	counter := func(code string) float64 {
		c, err := httpRequestsTotal.GetMetricWithLabelValues("not_found", "GET", code)
		if err != nil {
			t.Fatal(err)
		}
		return testutil.ToFloat64(c)
	}
	before := counter("404")
	w := serveAs(r, "GET", "/api/nope/abc123", true)
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "Not found") {
		t.Fatalf("got %d %q", w.Code, w.Body.String())
	}
	if got := counter("404") - before; got != 1 {
		t.Errorf("not_found counter delta = %v, want 1", got)
	}
	if w.Header().Get("X-Content-Type-Options") == "" {
		t.Error("security headers missing on 404")
	}
	if w := serveAs(r, "GET", "/api/nope", false); w.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated unknown path = %d, want 401", w.Code)
	}
}

func TestRouterMethodNotAllowedThroughMiddleware(t *testing.T) {
	r := stackRouter(t)
	c, err := httpRequestsTotal.GetMetricWithLabelValues("not_found", "PATCH", "405")
	if err != nil {
		t.Fatal(err)
	}
	before := testutil.ToFloat64(c)
	w := serveAs(r, "PATCH", "/api/health", true)
	if w.Code != http.StatusMethodNotAllowed || !strings.Contains(w.Body.String(), "Method not allowed") {
		t.Fatalf("got %d %q", w.Code, w.Body.String())
	}
	if allow := w.Header().Get("Allow"); allow != "GET, HEAD" {
		t.Errorf("Allow = %q, want %q", allow, "GET, HEAD")
	}
	if got := testutil.ToFloat64(c) - before; got != 1 {
		t.Errorf("counter delta = %v, want 1", got)
	}
}

func TestRouterAllowListIncludesNonStandardMethods(t *testing.T) {
	r := buildRouter(routerDeps{})
	r.HandleFunc("/api/patch-only", func(http.ResponseWriter, *http.Request) {}).Methods("PATCH")
	w := serveAs(r, "GET", "/api/patch-only", false)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "PATCH" {
		t.Fatalf("got %d Allow=%q", w.Code, w.Header().Get("Allow"))
	}
}

func TestRouterAnswersHead(t *testing.T) {
	r := stackRouter(t)
	for _, p := range []string{"/api/health", "/api/version", "/api/config"} {
		w := serveAs(r, "HEAD", p, true)
		if w.Code == http.StatusMethodNotAllowed || w.Code == http.StatusNotFound {
			t.Errorf("HEAD %s = %d", p, w.Code)
		}
	}
	if w := serveAs(r, "HEAD", "/api/health", true); w.Code != http.StatusOK && w.Code != http.StatusServiceUnavailable {
		t.Errorf("HEAD /api/health = %d", w.Code)
	}
}
