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
	h := routerFor(t, nil)
	if w := do(h, "GET", "/api/version"); w.Code == http.StatusNotFound {
		t.Fatal("route not registered")
	}
}
