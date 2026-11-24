package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSPAHandlerCacheControl(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"index.html":           "<html></html>",
		"assets/index-abc.js":  "console.log(1)",
		"assets/index-abc.css": "body{}",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	h := spaHandler(dir)
	const immutable = "public, max-age=31536000, immutable"
	cases := []struct {
		name   string
		path   string
		status int
		cc     string
	}{
		{"hashed js", "/assets/index-abc.js", http.StatusOK, immutable},
		{"hashed css", "/assets/index-abc.css", http.StatusOK, immutable},
		// A missing hashed asset must not be cached as immutable; the 404
		// body's Cache-Control is whatever net/http sets, so it is asserted
		// separately below.
		{"missing asset is not immutable", "/assets/missing-xyz.js", http.StatusNotFound, ""},
		{"root serves index", "/", http.StatusOK, "no-cache"},
		{"spa route serves index", "/missions/123", http.StatusOK, "no-cache"},
		{"explicit index.html", "/index.html", http.StatusMovedPermanently, "no-cache"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if rec.Code != tc.status {
				t.Errorf("status = %d, want %d", rec.Code, tc.status)
			}
			got := rec.Header().Get("Cache-Control")
			if tc.status == http.StatusNotFound {
				if got == immutable {
					t.Errorf("404 Cache-Control = %q, must not be immutable", got)
				}
				return
			}
			if got != tc.cc {
				t.Errorf("Cache-Control = %q, want %q", got, tc.cc)
			}
		})
	}
}
