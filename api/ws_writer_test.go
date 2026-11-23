package main

import (
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type fakeWSConn struct {
	mu     sync.Mutex
	writes int
	err    error
}

func (f *fakeWSConn) SetWriteDeadline(time.Time) error { return nil }
func (f *fakeWSConn) WriteMessage(int, []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.writes++
	return f.err
}

func TestWSWriterWriteAndClose(t *testing.T) {
	c := &fakeWSConn{}
	w := &wsWriter{conn: c}
	if !w.write(websocket.TextMessage, []byte("a")) || c.writes != 1 {
		t.Fatalf("expected successful write, writes=%d", c.writes)
	}
	w.markClosed()
	if !w.isClosed() || w.write(websocket.PingMessage, nil) || c.writes != 1 {
		t.Fatalf("write after close must be dropped, writes=%d", c.writes)
	}
}

func TestWSWriterFailedWriteMarksClosed(t *testing.T) {
	c := &fakeWSConn{err: errors.New("boom")}
	w := &wsWriter{conn: c}
	if w.write(websocket.TextMessage, []byte("a")) {
		t.Fatal("expected failure")
	}
	if !w.isClosed() {
		t.Fatal("failed write should mark closed")
	}
	if w.write(websocket.PingMessage, nil) || c.writes != 1 {
		t.Fatalf("no writes after failure, writes=%d", c.writes)
	}
}

// Under `go test -race` this fails on the old plain-bool design: readers
// (ping loop) and markClosed/failed writes touch the flag concurrently.
func TestWSWriterConcurrentNoRace(t *testing.T) {
	c := &fakeWSConn{}
	w := &wsWriter{conn: c}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				w.write(websocket.TextMessage, []byte("x"))
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 200; j++ {
				_ = w.isClosed()
			}
		}()
		go func() { defer wg.Done(); w.markClosed() }()
	}
	wg.Wait()
	if !w.isClosed() {
		t.Fatal("expected closed")
	}
}

// slowConn blocks every write until released, recording what was delivered.
type slowConn struct {
	mu      sync.Mutex
	got     []string
	gate    chan struct{}
	started chan struct{}
	once    sync.Once
}

func newSlowConn() *slowConn {
	return &slowConn{gate: make(chan struct{}, 1<<16), started: make(chan struct{})}
}
func (s *slowConn) SetWriteDeadline(time.Time) error { return nil }
func (s *slowConn) WriteMessage(_ int, d []byte) error {
	s.once.Do(func() { close(s.started) })
	<-s.gate
	s.mu.Lock()
	s.got = append(s.got, string(d))
	s.mu.Unlock()
	return nil
}
func (s *slowConn) delivered() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.got...)
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 500; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met")
}

func TestWSWriterQueueBoundedDropsOldestDroppable(t *testing.T) {
	c := newSlowConn()
	w := newWSWriter(c, 4, nil)
	go w.run()
	w.enqueue([]byte("m0"), false)
	<-c.started // writer is now blocked holding m0
	for i := 1; i <= 10; i++ {
		w.enqueue([]byte(fmt.Sprintf("m%d", i)), false)
		w.qmu.Lock()
		n := len(w.queue)
		w.qmu.Unlock()
		if n > 4 {
			t.Fatalf("queue exceeded bound: %d", n)
		}
	}
	if got := w.drops.Load(); got != 6 {
		t.Fatalf("drops=%d want 6", got)
	}
	for i := 0; i < 5; i++ {
		c.gate <- struct{}{}
	}
	waitFor(t, func() bool { return len(c.delivered()) == 5 })
	want := []string{"m0", "m7", "m8", "m9", "m10"} // newest kept, order preserved
	for i, g := range c.delivered() {
		if g != want[i] {
			t.Fatalf("delivered=%v want %v", c.delivered(), want)
		}
	}
	w.close()
	waitExit(t, w)
}

func TestWSWriterCriticalKeptDroppableEvicted(t *testing.T) {
	c := newSlowConn()
	w := newWSWriter(c, 3, nil)
	go w.run()
	w.enqueue([]byte("x"), true)
	<-c.started
	w.enqueue([]byte("t1"), false)
	w.enqueue([]byte("r1"), true)
	w.enqueue([]byte("t2"), false)
	w.enqueue([]byte("r2"), true) // evicts t1
	for i := 0; i < 4; i++ {
		c.gate <- struct{}{}
	}
	waitFor(t, func() bool { return len(c.delivered()) == 4 })
	want := []string{"x", "r1", "t2", "r2"}
	for i, g := range c.delivered() {
		if g != want[i] {
			t.Fatalf("delivered=%v want %v", c.delivered(), want)
		}
	}
	w.close()
	waitExit(t, w)
}

func TestWSWriterClosesWhenSaturatedWithCritical(t *testing.T) {
	c := newSlowConn()
	var closed atomic.Int32
	w := newWSWriter(c, 2, func() { closed.Add(1) })
	go w.run()
	w.enqueue([]byte("x"), true)
	<-c.started
	w.enqueue([]byte("r1"), true)
	w.enqueue([]byte("r2"), true)
	if w.enqueue([]byte("r3"), true) {
		t.Fatal("expected rejection")
	}
	if !w.isClosed() || closed.Load() != 1 {
		t.Fatalf("expected close once, closed=%d", closed.Load())
	}
	c.gate <- struct{}{}
	waitExit(t, w)
}

func TestWSWriterClosesWhenPersistentlySaturated(t *testing.T) {
	c := newSlowConn()
	var closed atomic.Int32
	w := newWSWriter(c, 2, func() { closed.Add(1) })
	go w.run()
	w.enqueue([]byte("x"), false)
	<-c.started
	for i := 0; i < wsMaxConsecutiveDrops+10 && !w.isClosed(); i++ {
		w.enqueue([]byte("t"), false)
	}
	if !w.isClosed() || closed.Load() != 1 {
		t.Fatalf("expected close, closed=%d", closed.Load())
	}
	c.gate <- struct{}{}
	waitExit(t, w)
}

func waitExit(t *testing.T, w *wsWriter) {
	t.Helper()
	select {
	case <-w.exited:
	case <-time.After(3 * time.Second):
		t.Fatal("writer goroutine leaked")
	}
}

func TestWSWriterNoGoroutineLeakOnClose(t *testing.T) {
	before := runtime.NumGoroutine()
	for i := 0; i < 20; i++ {
		w := newWSWriter(&fakeWSConn{}, 4, nil)
		go w.run()
		w.enqueue([]byte("a"), false)
		w.close()
		waitExit(t, w)
	}
	waitFor(t, func() bool { return runtime.NumGoroutine() <= before })
}

func TestWSWriterEnqueueAfterCloseDropped(t *testing.T) {
	w := newWSWriter(&fakeWSConn{}, 4, nil)
	go w.run()
	w.close()
	if w.enqueue([]byte("a"), true) {
		t.Fatal("enqueue after close must fail")
	}
	waitExit(t, w)
}
