package main

import (
	"context"
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
			if ce.Code != websocket.CloseMessageTooBig {
				t.Fatalf("close code = %d, want %d (CloseMessageTooBig)", ce.Code, websocket.CloseMessageTooBig)
			}
			break
		}
	}
	// The server's wsRelease must have run before the test returns, so the
	// connection cap test does not depend on test order.
	waitFor(t, func() bool { return wsOpenConns.Load() == 0 })
}

// A normal activity subscribe, under the 64 KiB read limit, is still accepted:
// the server replies with a backlog instead of closing the connection.
func TestWSActivitySubscribeUnderReadLimit(t *testing.T) {
	conn, _ := startCardsNATS(t)
	oldNC := nc
	nc = conn
	t.Cleanup(func() { nc = oldNC })
	h := wsHandler(newTableSource("test", "fleet-a", ""), nil, newActivityStore(), nil, nil, nil)
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	// Pad the command to just under the limit with an ignored field.
	head := `{"subscribe":"activity","taskId":"task-under-limit","pad":"`
	tail := `"}`
	pad := strings.Repeat("x", wsMaxClientMessageBytes-1-len(head)-len(tail))
	msg := head + pad + tail
	if len(msg) >= wsMaxClientMessageBytes {
		t.Fatalf("test frame is %d bytes, must be under the %d limit", len(msg), wsMaxClientMessageBytes)
	}
	if err := c.WriteMessage(websocket.TextMessage, []byte(msg)); err != nil {
		t.Fatal(err)
	}
	c.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			t.Fatalf("connection closed before the subscribe reply: %v", err)
		}
		if strings.Contains(string(data), `"op":"backlog"`) {
			break
		}
	}
	// Free the connection slot before returning so TestWSConnectionCap does
	// not depend on test order.
	c.Close()
	waitFor(t, func() bool { return wsOpenConns.Load() == 0 })
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

// A table added while a socket is open gets its two subscriptions on the next
// refresh, a removed table's are unsubscribed, and nothing leaks on close (#630).
func TestWSFollowsTableChanges(t *testing.T) {
	conn, _ := startCardsNATS(t)
	oldNC, oldMax := nc, wsMaxConnections
	oldSub, oldUnsub, oldRefresh := wsSubscribe, wsUnsubscribe, wsTableRefresh
	nc = conn
	t.Cleanup(func() {
		nc, wsMaxConnections = oldNC, oldMax
		wsSubscribe, wsUnsubscribe, wsTableRefresh = oldSub, oldUnsub, oldRefresh
	})
	wsTableRefresh = 20 * time.Millisecond

	var mu sync.Mutex
	live := map[*nats.Subscription]string{}
	subjects := func() map[string]int {
		mu.Lock()
		defer mu.Unlock()
		out := map[string]int{}
		for _, s := range live {
			out[s]++
		}
		return out
	}
	wsSubscribe = func(subj string, _ nats.MsgHandler) (*nats.Subscription, error) {
		s := &nats.Subscription{}
		mu.Lock()
		live[s] = subj
		mu.Unlock()
		return s, nil
	}
	wsUnsubscribe = func(s *nats.Subscription) {
		mu.Lock()
		delete(live, s)
		mu.Unlock()
	}

	var tmu sync.Mutex
	tables := []TableInfo{{Name: "a", Prefix: "fleet-a"}}
	src := newTableSource("test", "", "")
	src.ttl = 0 // every refresh re-discovers
	src.discoverFn = func(context.Context) ([]TableInfo, error) {
		tmu.Lock()
		defer tmu.Unlock()
		return append([]TableInfo(nil), tables...), nil
	}
	srv := httptest.NewServer(wsHandler(src, nil, nil, nil, nil, nil))
	t.Cleanup(srv.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()

	has := func(subj string) bool { return subjects()[subj] == 1 }
	waitFor(t, func() bool { return has("fleet-a.tasks.>") && has("fleet-a.results.>") })

	tmu.Lock()
	tables = []TableInfo{{Name: "a", Prefix: "fleet-a"}, {Name: "b", Prefix: "fleet-b"}}
	tmu.Unlock()
	waitFor(t, func() bool { return has("fleet-b.tasks.>") && has("fleet-b.results.>") })
	if n := len(subjects()); n != 4 {
		t.Fatalf("subscriptions = %d, want 4 (no duplicates)", n)
	}

	tmu.Lock()
	tables = []TableInfo{{Name: "b", Prefix: "fleet-b"}}
	tmu.Unlock()
	waitFor(t, func() bool { s := subjects(); return len(s) == 2 && has("fleet-b.tasks.>") })

	c.Close()
	waitFor(t, func() bool { return len(subjects()) == 0 && wsOpenConns.Load() == 0 })
}
