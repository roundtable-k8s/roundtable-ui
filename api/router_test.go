package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func routerFor(t *testing.T, rl *rateLimiterT) http.Handler {
	t.Helper()
	r := setupTestRouter()
	if rl != nil {
		r.Use(rl.middleware)
	}
	return r
}

func do(h http.Handler, method, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(method, path, nil))
	return w
}

func TestUnknownAPIPathIsJSON404(t *testing.T) {
	for _, p := range []string{"/api/does-not-exist", "/api/kv/anything", "/api/"} {
		w := do(routerFor(t, nil), "GET", p)
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404", p, w.Code)
		}
		var body map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["error"] != "Not found" {
			t.Fatalf("%s: body %q", p, w.Body.String())
		}
	}
}

func TestWrongMethodIsJSON405(t *testing.T) {
	w := do(routerFor(t, nil), "POST", "/api/fleet")
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status %d, want 405", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["error"] != "Method not allowed" {
		t.Fatalf("body %q", w.Body.String())
	}
}

func TestNonAPIPathStillServesSPA(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := mkStatic("<html>spa</html>"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/fleet", "/chains?chain=x"} {
		w := do(routerFor(t, nil), "GET", p)
		if w.Code != http.StatusOK || w.Body.String() != "<html>spa</html>" {
			t.Fatalf("%s: %d %q", p, w.Code, w.Body.String())
		}
	}
}

func TestHealthBypassesRateLimiter(t *testing.T) {
	h := routerFor(t, newRateLimiter(1, time.Hour))
	if w := do(h, "GET", "/api/fleet"); w.Code == http.StatusTooManyRequests {
		t.Fatal("first request limited")
	}
	if w := do(h, "GET", "/api/fleet"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("ordinary route: %d, want 429", w.Code)
	}
	if w := do(h, "GET", "/api/health"); w.Code != http.StatusOK {
		t.Fatalf("health: %d, want 200", w.Code)
	}
}

func TestMetricsBypassesRateLimiter(t *testing.T) {
	rl := newRateLimiter(1, time.Hour)
	rl.allow()
	h := rl.middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	if w := do(h, "GET", "/metrics"); w.Code != http.StatusOK {
		t.Fatalf("metrics: %d, want 200", w.Code)
	}
	if w := do(h, "GET", "/api/x"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("other: %d, want 429", w.Code)
	}
}

func mkStatic(body string) error {
	if err := os.MkdirAll("static", 0o755); err != nil {
		return err
	}
	return os.WriteFile("static/index.html", []byte(body), 0o644)
}

func TestHeadSkipsStreamingRoutes(t *testing.T) {
	h := routerFor(t, nil)
	for _, p := range []string{"/api/chat/tasks/t1/events", "/api/fleet/k/logs"} {
		if w := do(h, "HEAD", p); w.Code != http.StatusMethodNotAllowed {
			t.Errorf("HEAD %s: status %d, want 405", p, w.Code)
		}
	}
	if w := do(h, "HEAD", "/api/fleet"); w.Code != http.StatusOK {
		t.Errorf("HEAD /api/fleet: status %d, want 200", w.Code)
	}
}
