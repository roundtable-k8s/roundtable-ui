package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// validTaskID guards the task ID that is forwarded into a gateway URL path.
var validTaskID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)

const gatewayMaxBody = 4 << 20 // cap on a gateway response we relay

// errGatewayBodyTooLarge means the gateway answered with more than gatewayMaxBody
// bytes. The body is discarded rather than relayed truncated.
var errGatewayBodyTooLarge = errors.New("gateway response exceeds relay limit")

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
		http:      newGatewayHTTPClient(http.DefaultTransport),
	}
}

// newGatewayHTTPClient wraps rt in an otelhttp transport so gateway calls are
// client spans carrying the W3C traceparent (a no-op without a tracer
// provider). The span name is the route template, never the raw path. The SSE
// copy in stream keeps this transport and only clears the Timeout.
func newGatewayHTTPClient(rt http.RoundTripper) *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		Transport: otelhttp.NewTransport(redactURLTransport{rt}, otelhttp.WithSpanNameFormatter(
			func(_ string, r *http.Request) string {
				return r.Method + " " + gatewayRouteTemplate(r.URL.Path)
			})),
	}
}

// redactURLTransport runs inside the otelhttp transport, where the client span
// is already in the request context. otelhttp records the raw URL as url.full
// (ids and query included); overwrite it with the templated path.
type redactURLTransport struct{ rt http.RoundTripper }

func (t redactURLTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if sp := trace.SpanFromContext(req.Context()); sp.IsRecording() {
		sp.SetAttributes(attribute.String("url.full", req.URL.Scheme+"://"+req.URL.Host+gatewayRouteTemplate(req.URL.Path)))
	}
	return t.rt.RoundTrip(req)
}

// gatewayIDSegments maps a gateway collection to the number of id segments
// that follow it; everything after those is a literal action word.
var gatewayIDSegments = map[string]int{
	"knights": 1, "tasks": 1, "dead-letters": 1, "chains": 1, "runs": 2, "schedules": 2,
}

// gatewayRouteTemplate turns /v1/runs/ns/run-1/cancel into
// /v1/runs/{namespace}/{name}/cancel so ids never reach span names.
func gatewayRouteTemplate(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) < 2 || parts[0] != "v1" {
		return "/"
	}
	n, ok := gatewayIDSegments[parts[1]]
	if !ok {
		return "/"
	}
	names := []string{"{id}"}
	if n == 2 {
		names = []string{"{namespace}", "{name}"}
	}
	out := parts[:2:2]
	for i, seg := range parts[2:] {
		if i < n {
			out = append(out, names[i])
		} else if seg == "manifest" || seg == "retry" || seg == "events" || seg == "cancel" ||
			seg == "invoke" || seg == "runs" || seg == "suspend" || seg == "resume" || seg == "run" ||
			seg == "snapshot" || seg == "snapshots" {
			out = append(out, seg)
		} else {
			out = append(out, "{id}")
		}
	}
	return "/" + strings.Join(out, "/")
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
func (g *gatewayClient) bearer(ctx context.Context, reload bool) string {
	if g.tokenFile == "" {
		return g.token
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if reload || g.fileToken == "" {
		t, err := readTokenFile(g.tokenFile)
		if err != nil {
			slog.WarnContext(ctx, "cannot read gateway token file", "error", err)
			return g.fileToken
		}
		g.fileToken = t
	}
	return g.fileToken
}

// do calls the gateway and returns its status and body.
func (g *gatewayClient) do(ctx context.Context, method, path string, query url.Values, body []byte) (int, []byte, error) {
	status, b, _, err := g.doKeyed(ctx, method, path, query, body, "")
	return status, b, err
}

// doKeyed is do with an optional Idempotency-Key for the gateway; it also
// returns the gateway's response headers.
func (g *gatewayClient) doKeyed(ctx context.Context, method, path string, query url.Values, body []byte, idemKey string) (int, []byte, http.Header, error) {
	status, b, hdr, err := g.doOnce(ctx, method, path, query, body, g.bearer(ctx, false), idemKey)
	if err == nil && status == http.StatusUnauthorized && g.tokenFile != "" {
		// The token may have been rotated: re-read the file and retry once.
		status, b, hdr, err = g.doOnce(ctx, method, path, query, body, g.bearer(ctx, true), idemKey)
	}
	return status, b, hdr, err
}

func (g *gatewayClient) doOnce(ctx context.Context, method, path string, query url.Values, body []byte, token, idemKey string) (int, []byte, http.Header, error) {
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
		return 0, nil, nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := g.http.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	// Read one byte past the cap so an oversized body is detected, not cut.
	b, err := io.ReadAll(io.LimitReader(resp.Body, gatewayMaxBody+1))
	if err == nil && len(b) > gatewayMaxBody {
		return resp.StatusCode, nil, resp.Header, errGatewayBodyTooLarge
	}
	return resp.StatusCode, b, resp.Header, err
}

// idempotencyKey reads the caller's Idempotency-Key header. ok is false (and a
// 400 has been written) when the value is empty after trim, longer than 255
// or not printable ASCII. An absent header yields "", true.
func idempotencyKey(w http.ResponseWriter, r *http.Request) (string, bool) {
	vals := r.Header.Values("Idempotency-Key")
	if len(vals) == 0 {
		return "", true
	}
	k := strings.TrimSpace(vals[0])
	valid := k != "" && len(k) <= 255
	for i := 0; valid && i < len(k); i++ {
		valid = k[i] >= 0x20 && k[i] <= 0x7e
	}
	if !valid {
		jsonError(w, "Invalid Idempotency-Key (1-255 printable ASCII characters)", http.StatusBadRequest)
		return "", false
	}
	return k, true
}

// relay writes the gateway's status and JSON body back to the client.
func (g *gatewayClient) relay(w http.ResponseWriter, r *http.Request, method, path string, query url.Values, body []byte) {
	g.relayKeyed(w, r, method, path, query, body, "")
}

// relayKeyed is relay that forwards idemKey as the gateway's Idempotency-Key
// and copies the gateway's Idempotent-Replay header back to the client.
func (g *gatewayClient) relayKeyed(w http.ResponseWriter, r *http.Request, method, path string, query url.Values, body []byte, idemKey string) {
	if g.baseURL == "" {
		jsonError(w, "Gateway not configured (set GATEWAY_URL)", http.StatusServiceUnavailable)
		return
	}
	status, b, hdr, err := g.doKeyed(r.Context(), method, path, query, body, idemKey)
	if errors.Is(err, errGatewayBodyTooLarge) {
		slog.WarnContext(r.Context(), "gateway response over relay limit", "path", path, "limit_bytes", gatewayMaxBody)
		jsonError(w, "Gateway response too large", http.StatusBadGateway)
		return
	}
	if err != nil {
		slog.ErrorContext(r.Context(), "gateway request failed", "path", path, "error", err)
		jsonError(w, "Gateway unreachable", http.StatusBadGateway)
		return
	}
	if v := hdr.Get("Idempotent-Replay"); v != "" {
		w.Header().Set("Idempotent-Replay", v)
	}
	writeGatewayResponse(w, status, b)
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
