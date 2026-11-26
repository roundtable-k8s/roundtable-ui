package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
)

// validTaskID guards the task ID that is forwarded into a gateway URL path.
var validTaskID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)

const gatewayMaxBody = 4 << 20 // cap on a gateway response we relay

// gatewayClient is a small client for the roundtable gateway API. Actions go
// through the gateway, not NATS (whiteboard decision 6).
type gatewayClient struct {
	baseURL string // GATEWAY_URL; empty = not configured
	token   string // GATEWAY_TOKEN; optional bearer token (used when no token file is set)
	// tokenFile is GATEWAY_TOKEN_FILE: the bearer token is its first line,
	// read on first use and again after the gateway answers 401 (rotation).
	tokenFile string
	mu        sync.Mutex
	fileToken string
	http      *http.Client
}

func newGatewayClientFromEnv() *gatewayClient {
	return &gatewayClient{
		baseURL:   strings.TrimRight(strings.TrimSpace(os.Getenv("GATEWAY_URL")), "/"),
		token:     strings.TrimSpace(os.Getenv("GATEWAY_TOKEN")),
		tokenFile: strings.TrimSpace(os.Getenv("GATEWAY_TOKEN_FILE")),
		http:      &http.Client{Timeout: 30 * time.Second},
	}
}

// readTokenFile returns the first line of the token file.
func readTokenFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(string(b), "\n")
	return strings.TrimSpace(line), nil
}

// bearer returns the token to send. With a token file the cached value is
// used; reload re-reads the file first (after a 401).
func (g *gatewayClient) bearer(reload bool) string {
	if g.tokenFile == "" {
		return g.token
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if reload || g.fileToken == "" {
		t, err := readTokenFile(g.tokenFile)
		if err != nil {
			slog.Warn("cannot read gateway token file", "error", err)
			return g.fileToken
		}
		g.fileToken = t
	}
	return g.fileToken
}

// do calls the gateway and returns its status and body.
func (g *gatewayClient) do(ctx context.Context, method, path string, query url.Values, body []byte) (int, []byte, error) {
	status, b, err := g.doOnce(ctx, method, path, query, body, g.bearer(false))
	if err == nil && status == http.StatusUnauthorized && g.tokenFile != "" {
		// The token may have been rotated: re-read the file and retry once.
		status, b, err = g.doOnce(ctx, method, path, query, body, g.bearer(true))
	}
	return status, b, err
}

func (g *gatewayClient) doOnce(ctx context.Context, method, path string, query url.Values, body []byte, token string) (int, []byte, error) {
	u := g.baseURL + path
	if len(query) > 0 {
		u += "?" + query.Encode()
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u, rd)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := g.http.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, gatewayMaxBody))
	return resp.StatusCode, b, err
}

// relay writes the gateway's status and JSON body back to the client.
func (g *gatewayClient) relay(w http.ResponseWriter, r *http.Request, method, path string, query url.Values, body []byte) {
	if g.baseURL == "" {
		jsonError(w, "Gateway not configured (set GATEWAY_URL)", http.StatusServiceUnavailable)
		return
	}
	status, b, err := g.do(r.Context(), method, path, query, body)
	if err != nil {
		slog.Error("gateway request failed", "path", path, "error", err)
		jsonError(w, "Gateway unreachable", http.StatusBadGateway)
		return
	}
	writeGatewayError(w, status, b)
}

// deadLettersHandler proxies GET /v1/dead-letters (knight, reason, state, limit).
func deadLettersHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := url.Values{}
		for _, k := range []string{"knight", "reason", "state", "limit"} {
			if v := r.URL.Query().Get(k); v != "" {
				q.Set(k, v)
			}
		}
		g.relay(w, r, http.MethodGet, "/v1/dead-letters", q, nil)
	}
}

// deadLetterDetailHandler proxies GET /v1/dead-letters/{taskId} (includes the
// original task payload, which the list omits).
func deadLetterDetailHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["taskId"]
		if !validTaskID.MatchString(id) {
			jsonError(w, "Invalid task ID", http.StatusBadRequest)
			return
		}
		q := url.Values{}
		if t := r.URL.Query().Get("table"); t != "" {
			q.Set("table", t)
		}
		g.relay(w, r, http.MethodGet, "/v1/dead-letters/"+url.PathEscape(id), q, nil)
	}
}

// deadLetterRetryHandler proxies POST /v1/dead-letters/{taskId}/retry. Only
// force and table are forwarded; gateway status codes (409, 422...) pass through.
func deadLetterRetryHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["taskId"]
		if !validTaskID.MatchString(id) {
			jsonError(w, "Invalid task ID", http.StatusBadRequest)
			return
		}
		var req struct {
			Force bool   `json:"force,omitempty"`
			Table string `json:"table,omitempty"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil && err != io.EOF {
			jsonError(w, "Invalid request", http.StatusBadRequest)
			return
		}
		if req.Table != "" && !validKnightName.MatchString(req.Table) {
			jsonError(w, "Invalid table name", http.StatusBadRequest)
			return
		}
		body, _ := json.Marshal(req)
		g.relay(w, r, http.MethodPost, "/v1/dead-letters/"+url.PathEscape(id)+"/retry", nil, body)
	}
}
