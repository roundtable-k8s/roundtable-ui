package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVersionHandler(t *testing.T) {
	old := version
	version = "1.2.3"
	defer func() { version = old }()

	w := httptest.NewRecorder()
	versionHandler()(w, httptest.NewRequest("GET", "/api/version", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content type %q", ct)
	}
	var m map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"version", "commit", "buildTime", "goVersion"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing key %q", k)
		}
	}
	if m["version"] != "1.2.3" {
		t.Errorf("version %q", m["version"])
	}
}

func TestVersionRouteRequiresAuth(t *testing.T) {
	t.Setenv("DASHBOARD_API_KEY", "secret")
	r := setupTestRouter()
	r.Use(authMiddleware)

	if w := do(r, "GET", "/api/version"); w.Code != http.StatusUnauthorized {
		t.Fatalf("no key: status %d, want 401", w.Code)
	}
	req := httptest.NewRequest("GET", "/api/version", nil)
	req.Header.Set("Authorization", "Bearer secret")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("with key: status %d, want 200", w.Code)
	}
}

func TestVersionCommitFromLdflags(t *testing.T) {
	old := commit
	commit = "abcdef0123"
	defer func() { commit = old }()
	if got := currentVersion().Commit; got != "abcdef0123" {
		t.Errorf("commit %q", got)
	}
}
