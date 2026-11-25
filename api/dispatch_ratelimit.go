package main

import (
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var dispatchRateLimited = promauto.NewCounter(prometheus.CounterOpts{
	Name: "roundtable_ui_dispatch_rate_limited_total",
	Help: "Dispatch and run-now requests rejected by the dispatch rate limiter.",
})

const (
	defaultDispatchRate  = 2.0 // tokens per second
	defaultDispatchBurst = 10
)

// tokenBucket is a minimal token bucket with an injectable clock.
type tokenBucket struct {
	mu     sync.Mutex
	rate   float64 // tokens per second
	burst  float64
	tokens float64
	last   time.Time
	now    func() time.Time
}

func newTokenBucket(rate float64, burst int, now func() time.Time) *tokenBucket {
	if now == nil {
		now = time.Now
	}
	if burst < 1 {
		burst = 1
	}
	return &tokenBucket{rate: rate, burst: float64(burst), tokens: float64(burst), last: now(), now: now}
}

// allow consumes one token if available.
func (b *tokenBucket) allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.now()
	if el := t.Sub(b.last).Seconds(); el > 0 {
		b.tokens += el * b.rate
		if b.tokens > b.burst {
			b.tokens = b.burst
		}
		b.last = t
	}
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

// dispatchLimits reads the dispatch/run-now limits from the environment:
// DISPATCH_RATE (requests/sec; <=0 disables limiting) and DISPATCH_BURST.
func dispatchLimits() (rate float64, burst int) {
	rate, burst = defaultDispatchRate, defaultDispatchBurst
	if v := envOr("DISPATCH_RATE", ""); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			rate = f
		} else {
			slog.Warn("invalid DISPATCH_RATE, using default", "value", v)
		}
	}
	if v := envOr("DISPATCH_BURST", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			burst = n
		} else {
			slog.Warn("invalid DISPATCH_BURST, using default", "value", v)
		}
	}
	return
}

// dispatchLimiter rate-limits the endpoints that start work through the
// gateway (task dispatch and chain run-now).
type dispatchLimiter struct{ bucket *tokenBucket } // nil bucket = disabled

func newDispatchLimiter() *dispatchLimiter {
	rate, burst := dispatchLimits()
	if rate <= 0 {
		return &dispatchLimiter{}
	}
	return &dispatchLimiter{bucket: newTokenBucket(rate, burst, nil)}
}

func (l *dispatchLimiter) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if l.bucket != nil && !l.bucket.allow() {
			dispatchRateLimited.Inc()
			w.Header().Set("Retry-After", "1")
			jsonError(w, "dispatch rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}
