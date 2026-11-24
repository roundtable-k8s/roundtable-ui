package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestJsonErrorWritesJSONBody(t *testing.T) {
	w := httptest.NewRecorder()
	jsonError(w, "Knight not found", http.StatusNotFound)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if nosniff := w.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", nosniff)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", w.Body.String(), err)
	}
	if body["error"] != "Knight not found" {
		t.Errorf("error = %q, want %q", body["error"], "Knight not found")
	}
}

func TestAuthRejectionIsJSON(t *testing.T) {
	t.Setenv("DASHBOARD_API_KEY", "secret")
	h := authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/fleet", nil)
	h.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", w.Body.String(), err)
	}
	if body["error"] != "Unauthorized" {
		t.Errorf("error = %q, want Unauthorized", body["error"])
	}
}
