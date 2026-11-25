package main

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"

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
		if len(req.Message) == 0 || len(req.Message) > maxDispatchTaskLen {
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
		body := map[string]interface{}{"task": req.Message, "timeoutSeconds": 0}
		if req.Model != "" {
			body["model"] = req.Model
		}
		if req.RunID != "" {
			body["runId"] = req.RunID
		}
		b, _ := json.Marshal(body)
		g.relay(w, r, http.MethodPost, "/v1/knights/"+url.PathEscape(knight)+"/invoke", nil, b)
	}
}

// chatKnightsHandler proxies GET /v1/knights: who the gateway can reach.
func chatKnightsHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		g.relay(w, r, http.MethodGet, "/v1/knights", nil, nil)
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
		if g.baseURL == "" {
			jsonError(w, "Gateway not configured (set GATEWAY_URL)", http.StatusServiceUnavailable)
			return
		}
		path := "/v1/tasks/" + url.PathEscape(id) + "/events"
		resp, err := g.stream(r, path, g.bearer(false))
		if err == nil && resp.StatusCode == http.StatusUnauthorized && g.tokenFile != "" {
			resp.Body.Close()
			resp, err = g.stream(r, path, g.bearer(true))
		}
		if err != nil {
			slog.Error("gateway stream failed", "path", path, "error", err)
			jsonError(w, "Gateway unreachable", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			msg := http.StatusText(resp.StatusCode)
			if resp.StatusCode == http.StatusNotFound {
				msg = "Task events not available"
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
				if _, werr := w.Write(buf[:n]); werr != nil {
					return
				}
				if fl != nil {
					fl.Flush()
				}
			}
			if rerr != nil {
				if rerr != io.EOF {
					slog.Debug("gateway stream ended", "error", rerr)
				}
				return
			}
		}
	}
}

// stream opens a long-lived GET to the gateway (no overall client timeout;
// the request context ends it when the browser disconnects).
func (g *gatewayClient) stream(r *http.Request, path, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, g.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	c := *g.http
	c.Timeout = 0
	return c.Do(req)
}
