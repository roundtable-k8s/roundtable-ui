package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/nats-io/nats.go"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

// wsLimitsServer serves wsHandler (no registries) against an embedded NATS.
func wsLimitsServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	conn, _ := startCardsNATS(t)
	oldNC, oldMax := nc, wsMaxConnections
	nc = conn
	t.Cleanup(func() { nc, wsMaxConnections = oldNC, oldMax })
	h := wsHandler(newTableSource("test", "fleet-a", ""), nil, nil, nil, nil, nil)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv, "ws" + strings.TrimPrefix(srv.URL, "http")
}

func TestWSOversizeMessageClosesConnection(t *testing.T) {
	_, url := wsLimitsServer(t)
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// Frame larger than the limit (1 MiB, per the acceptance criteria).
	_ = c.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", 1<<20)))
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := c.ReadMessage(); err != nil {
			var ce *websocket.CloseError
			if !errors.As(err, &ce) {
				t.Fatalf("expected the server to close the connection, got %v", err)
			}
			return
		}
	}
}

func TestWSConnectionCap(t *testing.T) {
	srv, url := wsLimitsServer(t)
	wsMaxConnections = 2
	rejected := testutil.ToFloat64(wsRejectedTotal)

	var conns []*websocket.Conn
	for i := 0; i < 2; i++ {
		c, _, err := websocket.DefaultDialer.Dial(url, nil)
		if err != nil {
			t.Fatalf("conn %d: %v", i, err)
		}
		conns = append(conns, c)
	}
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("third connection: err=%v resp=%v, want 503", err, resp)
	}
	if resp.Header.Get("Retry-After") != "5" {
		t.Errorf("Retry-After = %q", resp.Header.Get("Retry-After"))
	}
	if got := testutil.ToFloat64(wsRejectedTotal) - rejected; got != 1 {
		t.Errorf("rejected counter delta = %v, want 1", got)
	}
	if got := testutil.ToFloat64(wsConnections); got != 2 {
		t.Errorf("gauge = %v, want 2", got)
	}

	conns[0].Close()
	waitFor(t, func() bool { return wsOpenConns.Load() == 1 })
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("connection after a close: %v", err)
	}
	conns = append(conns[1:], c)
	for _, c := range conns {
		c.Close()
	}
	waitFor(t, func() bool { return wsOpenConns.Load() == 0 && testutil.ToFloat64(wsConnections) == 0 })
	_ = srv
}

func TestWSUnlimitedConnections(t *testing.T) {
	old := wsMaxConnections
	defer func() { wsMaxConnections = old }()
	wsMaxConnections = 0
	for i := 0; i < 5; i++ {
		if !wsAcquire() {
			t.Fatal("cap 0 must mean unlimited")
		}
	}
	for i := 0; i < 5; i++ {
		wsRelease()
	}
}

func TestWSSubscribeFailureStopsWriter(t *testing.T) {
	_, url := wsLimitsServer(t)
	oldSub := wsSubscribe
	oldHook := wsWriterHook
	t.Cleanup(func() { wsSubscribe, wsWriterHook = oldSub, oldHook })
	wsSubscribe = func(string, nats.MsgHandler) (*nats.Subscription, error) {
		return nil, errors.New("boom")
	}
	var mu sync.Mutex
	var writers []*wsWriter
	wsWriterHook = func(w *wsWriter) {
		mu.Lock()
		writers = append(writers, w)
		mu.Unlock()
	}
	c, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(writers) == 1 })
	waitExit(t, writers[0])
	waitFor(t, func() bool { return wsOpenConns.Load() == 0 })
}
