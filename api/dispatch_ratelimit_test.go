package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestDispatchLimiterBurstRejectRefill(t *testing.T) {
	now := time.Unix(1000, 0)
	l := &dispatchLimiter{bucket: newTokenBucket(1, 2, func() time.Time { return now })}
	h := l.wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	call := func() int {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/x", nil))
		return w.Code
	}
	before := testutil.ToFloat64(dispatchRateLimited)
	if call() != 200 || call() != 200 {
		t.Fatal("requests within burst must pass")
	}
	if call() != http.StatusTooManyRequests {
		t.Fatal("request over burst must get 429")
	}
	if got := testutil.ToFloat64(dispatchRateLimited) - before; got != 1 {
		t.Fatalf("metric delta = %v, want 1", got)
	}
	now = now.Add(1500 * time.Millisecond)
	if call() != 200 || call() != http.StatusTooManyRequests {
		t.Fatal("exactly one token should have refilled")
	}
}

func TestDispatchLimiterDisabled(t *testing.T) {
	h := (&dispatchLimiter{}).wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	for i := 0; i < 50; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/x", nil))
		if w.Code != 200 {
			t.Fatalf("disabled limiter rejected request %d", i)
		}
	}
}

func TestTokenBucketRefillCap(t *testing.T) {
	now := time.Unix(0, 0)
	b := newTokenBucket(100, 2, func() time.Time { return now })
	now = now.Add(time.Hour)
	if !b.allow() || !b.allow() || b.allow() {
		t.Fatal("refill must be capped at burst")
	}
}

func TestDispatchLimitsEnv(t *testing.T) {
	r, n := dispatchLimits()
	if r != defaultDispatchRate || n != defaultDispatchBurst {
		t.Fatalf("defaults wrong: %v %v", r, n)
	}
	t.Setenv("DISPATCH_RATE", "5")
	t.Setenv("DISPATCH_BURST", "20")
	if r, n = dispatchLimits(); r != 5 || n != 20 {
		t.Fatalf("env wrong: %v %v", r, n)
	}
	for _, v := range []string{"0", "-1"} {
		t.Setenv("DISPATCH_RATE", v)
		if r, _ = dispatchLimits(); r > 0 {
			t.Fatalf("DISPATCH_RATE=%s must disable limiting, got rate %v", v, r)
		}
	}
}
