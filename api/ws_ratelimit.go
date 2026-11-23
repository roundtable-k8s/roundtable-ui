package main

import (
	"encoding/json"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var wsDispatchRateLimited = promauto.NewCounter(prometheus.CounterOpts{
	Name: "roundtable_ui_ws_dispatch_rate_limited_total",
	Help: "WebSocket dispatch messages rejected by the per-connection rate limiter.",
})

const (
	defaultWSDispatchRate  = 2.0 // tokens per second
	defaultWSDispatchBurst = 10
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

// wsDispatchLimits reads the per-connection dispatch limits from the
// environment: WS_DISPATCH_RATE (msgs/sec; <=0 disables limiting) and
// WS_DISPATCH_BURST (bucket size).
func wsDispatchLimits() (rate float64, burst int) {
	rate, burst = defaultWSDispatchRate, defaultWSDispatchBurst
	if v := envOr("WS_DISPATCH_RATE", ""); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			rate = f
		} else {
			slog.Warn("invalid WS_DISPATCH_RATE, using default", "value", v)
		}
	}
	if v := envOr("WS_DISPATCH_BURST", ""); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			burst = n
		} else {
			slog.Warn("invalid WS_DISPATCH_BURST, using default", "value", v)
		}
	}
	return
}

// checkDispatchLimit returns true if the dispatch may proceed. Otherwise it
// counts the rejection and queues a structured error reply on the connection's
// bounded outbound queue. The reply is never written to the socket directly, so
// a slow client cannot stall the read loop. It is enqueued as critical so it is
// not silently dropped under the backpressure policy (see wsWriter).
// A nil bucket means limiting is disabled.
func checkDispatchLimit(b *tokenBucket, ws *wsWriter) bool {
	if b == nil || b.allow() {
		return true
	}
	wsDispatchRateLimited.Inc()
	reply, _ := json.Marshal(map[string]interface{}{
		"type":  "error",
		"code":  "rate_limited",
		"error": "dispatch rate limit exceeded",
	})
	ws.enqueue(reply, true)
	return false
}
