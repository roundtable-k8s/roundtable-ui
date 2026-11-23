package main

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

type recConn struct {
	mu   sync.Mutex
	msgs [][]byte
}

func (r *recConn) SetWriteDeadline(time.Time) error { return nil }
func (r *recConn) WriteMessage(_ int, d []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, d)
	return nil
}

func (r *recConn) snapshot() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]byte(nil), r.msgs...)
}

// blockConn blocks every write until released, simulating a slow client.
type blockConn struct{ release chan struct{} }

func (b *blockConn) SetWriteDeadline(time.Time) error { return nil }
func (b *blockConn) WriteMessage(int, []byte) error {
	<-b.release
	return nil
}

// A slow client must not stall the read loop: rate-limited replies go through
// the bounded queue and checkDispatchLimit returns immediately.
func TestDispatchLimitDoesNotBlockOnSlowClient(t *testing.T) {
	bc := &blockConn{release: make(chan struct{})}
	ws := newWSWriter(bc, 8, nil)
	go ws.run()
	defer func() { close(bc.release); ws.shutdown() }()

	now := time.Unix(0, 0)
	b := newTokenBucket(1, 1, func() time.Time { return now })
	b.allow() // exhaust burst

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Far more rejected dispatches than the queue holds.
		for i := 0; i < 100; i++ {
			if checkDispatchLimit(b, ws) {
				t.Error("dispatch should be rate limited")
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("checkDispatchLimit blocked on a slow client")
	}
}

func TestDispatchLimitReplyIsCritical(t *testing.T) {
	ws := newWSWriter(&recConn{}, 4, nil) // run() not started: messages stay queued
	b := newTokenBucket(1, 1, func() time.Time { return time.Unix(0, 0) })
	b.allow()
	if checkDispatchLimit(b, ws) {
		t.Fatal("expected rejection")
	}
	ws.qmu.Lock()
	defer ws.qmu.Unlock()
	if len(ws.queue) != 1 || !ws.queue[0].critical {
		t.Fatalf("expected one critical queued reply, got %+v", ws.queue)
	}
}

func TestDispatchLimitBurstRejectRefill(t *testing.T) {
	now := time.Unix(1000, 0)
	b := newTokenBucket(1, 3, func() time.Time { return now })
	rc := &recConn{}
	ws := newWSWriter(rc, 16, nil)
	go ws.run()
	defer ws.shutdown()
	before := testutil.ToFloat64(wsDispatchRateLimited)

	for i := 0; i < 3; i++ {
		if !checkDispatchLimit(b, ws) {
			t.Fatalf("dispatch %d within burst should be allowed", i)
		}
	}
	if n := len(rc.snapshot()); n != 0 {
		t.Fatalf("no replies expected within burst, got %d", n)
	}
	if checkDispatchLimit(b, ws) {
		t.Fatal("dispatch over burst should be rejected")
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(rc.snapshot()) < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	msgs := rc.snapshot()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 error reply, got %d", len(msgs))
	}
	var reply map[string]string
	if err := json.Unmarshal(msgs[0], &reply); err != nil || reply["type"] != "error" || reply["code"] != "rate_limited" {
		t.Fatalf("unexpected reply %s (%v)", msgs[0], err)
	}
	if got := testutil.ToFloat64(wsDispatchRateLimited) - before; got != 1 {
		t.Fatalf("metric delta = %v, want 1", got)
	}

	now = now.Add(1500 * time.Millisecond) // refills 1.5 tokens
	if !checkDispatchLimit(b, ws) {
		t.Fatal("dispatch after refill should be allowed")
	}
	if checkDispatchLimit(b, ws) {
		t.Fatal("only one token should have refilled")
	}
}

func TestDispatchLimitDisabledAndCap(t *testing.T) {
	if !checkDispatchLimit(nil, newWSWriter(&recConn{}, 4, nil)) {
		t.Fatal("nil bucket must allow")
	}
	now := time.Unix(0, 0)
	b := newTokenBucket(100, 2, func() time.Time { return now })
	now = now.Add(time.Hour)
	if !b.allow() || !b.allow() || b.allow() {
		t.Fatal("refill must be capped at burst")
	}
}

func TestWSDispatchLimitsEnv(t *testing.T) {
	r, n := wsDispatchLimits()
	if r != defaultWSDispatchRate || n != defaultWSDispatchBurst {
		t.Fatalf("defaults wrong: %v %v", r, n)
	}
	t.Setenv("WS_DISPATCH_RATE", "5")
	t.Setenv("WS_DISPATCH_BURST", "20")
	if r, n = wsDispatchLimits(); r != 5 || n != 20 {
		t.Fatalf("env wrong: %v %v", r, n)
	}
	for _, v := range []string{"0", "-1"} {
		t.Setenv("WS_DISPATCH_RATE", v)
		if r, _ = wsDispatchLimits(); r > 0 {
			t.Fatalf("WS_DISPATCH_RATE=%s must disable limiting, got rate %v", v, r)
		}
	}
}
