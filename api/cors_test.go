package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCORSAllowsIdempotencyKeyAndExposesReplay(t *testing.T) {
	h := newCORSHandler("https://ui.example", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	pre := httptest.NewRequest(http.MethodOptions, "/api/chat/galahad", nil)
	pre.Header.Set("Origin", "https://ui.example")
	pre.Header.Set("Access-Control-Request-Method", "POST")
	pre.Header.Set("Access-Control-Request-Headers", "idempotency-key")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, pre)
	if got := w.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(strings.ToLower(got), "idempotency-key") {
		t.Fatalf("Allow-Headers = %q", got)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/chat/galahad", nil)
	req.Header.Set("Origin", "https://ui.example")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if got := w.Header().Get("Access-Control-Expose-Headers"); !strings.Contains(got, "Idempotent-Replay") {
		t.Fatalf("Expose-Headers = %q", got)
	}
}
