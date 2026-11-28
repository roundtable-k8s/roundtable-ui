package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/gorilla/mux"
)

// Chat with a knight goes through the invoke gateway (whiteboard decision 6),
// one runId per conversation: the gateway continues the knight's agent
// session when an earlier turn's runId is passed. The dashboard API never
// publishes to NATS for chat.

// chatRequest is the body of POST /api/chat/{knight}.
type chatRequest struct {
	Message string `json:"message"`
	RunID   string `json:"runId,omitempty"`
	Model   string `json:"model,omitempty"`
	// Namespace of the knight; the gateway defaults it when empty.
	Namespace string `json:"namespace,omitempty"`
}

// chatSendHandler proxies POST /v1/knights/{knight}/invoke with
// timeoutSeconds 0: the gateway answers at once with the task record
// (taskId, runId) and the UI follows the turn by events or polling.
func chatSendHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		knight := mux.Vars(r)["knight"]
		if !validKnightName.MatchString(knight) {
			jsonError(w, "Invalid knight name", http.StatusBadRequest)
			return
		}
		var req chatRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			jsonError(w, "Invalid request", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(req.Message) == "" || utf8.RuneCountInString(req.Message) > maxDispatchTaskLen {
			jsonError(w, "Message must be 1-10000 characters", http.StatusBadRequest)
			return
		}
		if req.RunID != "" && !validTaskID.MatchString(req.RunID) {
			jsonError(w, "Invalid run ID", http.StatusBadRequest)
			return
		}
		if len(req.Model) > 200 {
			jsonError(w, "Invalid model", http.StatusBadRequest)
			return
		}
		if req.Namespace != "" && !validKnightName.MatchString(req.Namespace) {
			jsonError(w, "Invalid namespace", http.StatusBadRequest)
			return
		}
		key, ok := idempotencyKey(w, r)
		if !ok {
			return
		}
		body := map[string]interface{}{"task": req.Message, "timeoutSeconds": 0}
		if req.Namespace != "" {
			body["namespace"] = req.Namespace
		}
		if req.Model != "" {
			body["model"] = req.Model
		}
		if req.RunID != "" {
			body["runId"] = req.RunID
		}
		b, _ := json.Marshal(body)
		g.relayKeyed(w, r, http.MethodPost, "/v1/knights/"+url.PathEscape(knight)+"/invoke", nil, b, key)
	}
}

// chatKnightsHandler proxies GET /v1/knights: who the gateway can reach.
// Optional namespace and load (exactly "true" or "false") are forwarded;
// load=true makes the gateway add each knight's queue counts.
func chatKnightsHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		var query url.Values
		if ns := q.Get("namespace"); ns != "" {
			query = url.Values{"namespace": {ns}}
		}
		if q.Has("load") {
			load := q.Get("load")
			if load != "true" && load != "false" {
				jsonError(w, "load must be true or false", http.StatusBadRequest)
				return
			}
			if query == nil {
				query = url.Values{}
			}
			query.Set("load", load)
		}
		g.relay(w, r, http.MethodGet, "/v1/knights", query, nil)
	}
}

// chatEventsHandler proxies the gateway's SSE stream
// GET /v1/tasks/{taskId}/events. A non-200 answer (404 when the gateway has
// no events endpoint) is relayed as JSON so the UI can fall back to polling.
func chatEventsHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["taskId"]
		if !validTaskID.MatchString(id) {
			jsonError(w, "Invalid task ID", http.StatusBadRequest)
			return
		}
		g.relaySSE(w, r, "/v1/tasks/"+url.PathEscape(id)+"/events")
	}
}

// SSE relay limits. Variables so tests can shorten them.
var (
	sseIdleTimeout = 45 * time.Second // three gateway heartbeats
	sseMaxDuration = sseMaxFromEnv()
	sseSlots       = make(chan struct{}, sseMaxStreamsFromEnv())
)

const sseMaxStreamsDefault = 100

func sseMaxFromEnv() time.Duration {
	if v := strings.TrimSpace(os.Getenv("SSE_MAX_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
		slog.Warn("invalid SSE_MAX_SECONDS, using default", "value", v)
	}
	return 30 * time.Minute
}

func sseMaxStreamsFromEnv() int {
	if v := strings.TrimSpace(os.Getenv("SSE_MAX_STREAMS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
		slog.Warn("invalid SSE_MAX_STREAMS, using default", "value", v)
	}
	return sseMaxStreamsDefault
}

// validLastEventID accepts at most 128 printable ASCII characters.
func validLastEventID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for i := 0; i < len(id); i++ {
		if id[i] < 0x20 || id[i] > 0x7e {
			return false
		}
	}
	return true
}

// relaySSE proxies a gateway SSE stream at path to the browser. It forwards
// Last-Event-ID, passes the gateway's error message on non-200, ends when the
// upstream is idle, after sseMaxDuration or on server shutdown, and limits the
// number of open relays.
func (g *gatewayClient) relaySSE(w http.ResponseWriter, r *http.Request, path string) {
	if g.baseURL == "" {
		jsonError(w, "Gateway not configured (set GATEWAY_URL)", http.StatusServiceUnavailable)
		return
	}
	life := wsLife
	if !life.enter() {
		w.Header().Set("Retry-After", "5")
		jsonError(w, "Server shutting down", http.StatusServiceUnavailable)
		return
	}
	defer life.leave()
	slots := sseSlots
	select {
	case slots <- struct{}{}:
	default:
		sseRejectedTotal.Inc()
		w.Header().Set("Retry-After", "5")
		jsonError(w, "too many open event streams", http.StatusTooManyRequests)
		return
	}
	sseStreams.Inc()
	defer func() { <-slots; sseStreams.Dec() }()

	lastID := r.Header.Get("Last-Event-ID")
	if lastID != "" && !validLastEventID(lastID) {
		lastID = ""
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	idle := sseIdleTimeout
	idleTimer := time.AfterFunc(idle, cancel)
	defer idleTimer.Stop()
	maxTimer := time.AfterFunc(sseMaxDuration, cancel)
	defer maxTimer.Stop()
	var shuttingDown atomic.Bool
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-life.shutdown:
			shuttingDown.Store(true)
			cancel()
		case <-done:
		}
	}()

	resp, err := g.stream(ctx, path, g.bearer(ctx, false), lastID)
	if err == nil && resp.StatusCode == http.StatusUnauthorized && g.tokenFile != "" {
		resp.Body.Close()
		resp, err = g.stream(ctx, path, g.bearer(ctx, true), lastID)
	}
	if err != nil {
		slog.ErrorContext(r.Context(), "gateway stream failed", "path", path, "error", err)
		jsonError(w, "Gateway unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg := http.StatusText(resp.StatusCode)
		var body struct {
			Error string `json:"error"`
		}
		if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&body) == nil && body.Error != "" {
			msg = body.Error
		} else if resp.StatusCode == http.StatusNotFound {
			msg = "Task events not available"
		}
		if ra := resp.Header.Get("Retry-After"); ra != "" && validLastEventID(ra) {
			w.Header().Set("Retry-After", ra)
		}
		jsonError(w, msg, resp.StatusCode)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	fl, _ := w.(http.Flusher)
	buf := make([]byte, 4096)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			idleTimer.Reset(idle)
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if fl != nil {
				fl.Flush()
			}
		}
		if rerr != nil {
			if shuttingDown.Load() {
				io.WriteString(w, ": server shutting down\n\n")
				if fl != nil {
					fl.Flush()
				}
			} else if rerr != io.EOF {
				slog.DebugContext(r.Context(), "gateway stream ended", "error", rerr)
			}
			return
		}
	}
}

// stream opens a long-lived GET to the gateway (no overall client timeout;
// the request context ends it when the browser disconnects).
func (g *gatewayClient) stream(ctx context.Context, path, token, lastEventID string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	c := *g.http
	c.Timeout = 0
	return c.Do(req)
}
