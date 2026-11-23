package main

import (
	"errors"
	"sync"
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
