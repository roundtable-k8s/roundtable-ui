package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/mux"
)

type fakeGateway struct {
	mu    sync.Mutex
	calls []gwCall
	// handler overrides the default 202 {"ok":true} answer.
	handler func(call gwCall, w http.ResponseWriter)
}

func (f *fakeGateway) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		c := gwCall{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), string(b), r.Header.Get("Idempotency-Key")}
		f.mu.Lock()
		f.calls = append(f.calls, c)
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if f.handler != nil {
			f.handler(c, w)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, `{"taskId":"invoke-rt-ui-1","runId":"run-1","status":"pending"}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func dispatchRouter(g *gatewayClient) *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/api/tasks/dispatch", taskDispatchHandler(g)).Methods("POST")
	r.HandleFunc("/api/tasks/dispatch/{taskId}", taskStatusHandler(g)).Methods("GET")
	r.HandleFunc("/api/chains/{name}/run", chainRunHandler(g)).Methods("POST")
	r.HandleFunc("/api/chains/runs/{namespace}/{run}", chainRunStatusHandler(g)).Methods("GET")
	r.HandleFunc("/api/chains/runs/{namespace}/{run}/cancel", chainRunCancelHandler(g)).Methods("POST")
	return r
}

func TestDispatchProxiesInvoke(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := dispatchRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	w := doReq(r, "POST", "/api/tasks/dispatch", `{"knight":"rt-ui","task":"fix it","model":"opus","runId":"run-0","domain":"ignored"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	var resp map[string]string
	json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["taskId"] != "invoke-rt-ui-1" || resp["runId"] != "run-1" {
		t.Errorf("response %v", resp)
	}
	c := f.calls[0]
	if c.method != "POST" || c.path != "/v1/knights/rt-ui/invoke" || c.auth != "Bearer tok" {
		t.Errorf("gateway call %+v", c)
	}
	var body map[string]interface{}
	json.Unmarshal([]byte(c.body), &body)
	if body["task"] != "fix it" || body["model"] != "opus" || body["runId"] != "run-0" || body["timeoutSeconds"] != float64(0) {
		t.Errorf("gateway body %v", body)
	}
	if _, ok := body["domain"]; ok {
		t.Error("unknown fields must not be forwarded")
	}
}

func TestDispatchValidation(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := dispatchRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	long, _ := json.Marshal(map[string]string{"knight": "galahad", "task": strings.Repeat("a", maxDispatchTaskLen+1)})
	for name, body := range map[string]string{
		"bad knight":   `{"knight":"fleet.>","task":"x"}`,
		"path in name": `{"knight":"../x","task":"x"}`,
		"empty task":   `{"knight":"galahad","task":""}`,
		"too long":     string(long),
		"bad run id":   `{"knight":"galahad","task":"x","runId":"a/b"}`,
		"bad json":     `{`,
	} {
		if w := doReq(r, "POST", "/api/tasks/dispatch", body); w.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d", name, w.Code)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("invalid requests reached the gateway: %v", f.calls)
	}
}

func TestDispatchGatewayNotConfigured(t *testing.T) {
	r := dispatchRouter(&gatewayClient{http: http.DefaultClient})
	for _, c := range [][3]string{
		{"POST", "/api/tasks/dispatch", `{"knight":"galahad","task":"x"}`},
		{"GET", "/api/tasks/dispatch/t1", ""},
		{"POST", "/api/chains/nightly/run", `{}`},
		{"GET", "/api/chains/runs/roundtable/nightly-x", ""},
		{"POST", "/api/chains/runs/roundtable/nightly-x/cancel", `{}`},
	} {
		w := doReq(r, c[0], c[1], c[2])
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "Gateway not configured") {
			t.Errorf("%s %s: got %d %s", c[0], c[1], w.Code, w.Body)
		}
	}
}

func TestDispatchStatusProxiesTask(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		io.WriteString(w, `{"taskId":"t1","status":"succeeded","output":"done"}`)
	}}
	srv := f.server(t)
	r := dispatchRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	w := doReq(r, "GET", "/api/tasks/dispatch/t1", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"output":"done"`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if c := f.calls[0]; c.method != "GET" || c.path != "/v1/tasks/t1" {
		t.Errorf("gateway call %+v", c)
	}
	if w := doReq(r, "GET", "/api/tasks/dispatch/a%20b", ""); w.Code != 400 {
		t.Errorf("bad task id: %d", w.Code)
	}
}

func TestGatewayTokenFileRereadOn401(t *testing.T) {
	dir := t.TempDir()
	tokFile := filepath.Join(dir, "token")
	os.WriteFile(tokFile, []byte("old-token-0123456789\nsecond-line\n"), 0o600)
	f := &fakeGateway{handler: func(c gwCall, w http.ResponseWriter) {
		if c.auth != "Bearer new-token-0123456789" {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":"unauthorized"}`)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, `{"taskId":"t1"}`)
	}}
	srv := f.server(t)
	g := &gatewayClient{baseURL: srv.URL, tokenFile: tokFile, http: srv.Client()}
	r := dispatchRouter(g)

	// The first line of the file is the token.
	if got := g.bearer(context.Background(), false); got != "old-token-0123456789" {
		t.Fatalf("token = %q", got)
	}
	// Rotate: the cached token is rejected, the file is re-read and the call retried.
	os.WriteFile(tokFile, []byte("new-token-0123456789\n"), 0o600)
	w := doReq(r, "POST", "/api/tasks/dispatch", `{"knight":"galahad","task":"x"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if len(f.calls) != 2 || f.calls[0].auth != "Bearer old-token-0123456789" || f.calls[1].auth != "Bearer new-token-0123456789" {
		t.Errorf("calls %+v", f.calls)
	}
	// A persistent 401 is answered 502 (the dashboard's credential) after exactly one retry.
	f.calls = nil
	os.WriteFile(tokFile, []byte("bad-token-0123456789\n"), 0o600)
	g.fileToken = ""
	if w := doReq(r, "POST", "/api/tasks/dispatch", `{"knight":"galahad","task":"x"}`); w.Code != http.StatusBadGateway || len(f.calls) != 2 {
		t.Errorf("got %d after %d calls", w.Code, len(f.calls))
	}
}

func TestGatewayClientFromEnvTokenFile(t *testing.T) {
	tokFile := filepath.Join(t.TempDir(), "token")
	os.WriteFile(tokFile, []byte("file-token-0123456789\n"), 0o600)
	t.Setenv("GATEWAY_URL", "http://gw:8080/")
	t.Setenv("GATEWAY_TOKEN", "env-token")
	t.Setenv("GATEWAY_TOKEN_FILE", tokFile)
	g := newGatewayClientFromEnv()
	if g.baseURL != "http://gw:8080" || g.bearer(context.Background(), false) != "file-token-0123456789" {
		t.Errorf("baseURL=%q token=%q", g.baseURL, g.bearer(context.Background(), false))
	}
}

func TestChainRunProxiesInput(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, `{"run":"nightly-abc","namespace":"roundtable","phase":"Pending","done":false}`)
	}}
	srv := f.server(t)
	r := dispatchRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	w := doReq(r, "POST", "/api/chains/nightly/run", `{"input":"topic: nats","waitSeconds":60,"extra":1}`)
	if w.Code != http.StatusAccepted || !strings.Contains(w.Body.String(), `"run":"nightly-abc"`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	c := f.calls[0]
	if c.method != "POST" || c.path != "/v1/chains/nightly/runs" {
		t.Errorf("gateway call %+v", c)
	}
	var body map[string]interface{}
	json.Unmarshal([]byte(c.body), &body)
	if body["input"] != "topic: nats" || body["waitSeconds"] != float64(0) {
		t.Errorf("gateway body %v", body)
	}
	if _, ok := body["extra"]; ok {
		t.Error("unknown fields must not be forwarded")
	}

	// Input is optional and an empty body is fine.
	f.calls = nil
	if w := doReq(r, "POST", "/api/chains/nightly/run", ``); w.Code != http.StatusAccepted {
		t.Errorf("no body: %d", w.Code)
	}
	if w := doReq(r, "POST", "/api/chains/bad.name/run", `{}`); w.Code != 400 {
		t.Errorf("bad chain name: %d", w.Code)
	}
	if len(f.calls) != 1 {
		t.Errorf("calls %v", f.calls)
	}
}

func TestChainRunStatusProxies(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) { io.WriteString(w, `{"run":"nightly-abc","done":true}`) }}
	srv := f.server(t)
	r := dispatchRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	if w := doReq(r, "GET", "/api/chains/runs/roundtable/nightly-abc", ""); w.Code != 200 {
		t.Fatalf("got %d", w.Code)
	}
	if c := f.calls[0]; c.path != "/v1/runs/roundtable/nightly-abc" {
		t.Errorf("gateway call %+v", c)
	}
}

func TestChainRunGateway404Passthrough(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		w.WriteHeader(http.StatusForbidden)
		io.WriteString(w, `{"error":"chain is not invokable"}`)
	}}
	srv := f.server(t)
	r := dispatchRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	w := doReq(r, "POST", "/api/chains/nightly/run", `{}`)
	if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "not invokable") {
		t.Errorf("got %d %s", w.Code, w.Body)
	}
}

// The dashboard API starts work only through the gateway: no NATS publish of
// task messages and no WebSocket dispatch command (#247).
func TestNoDirectTaskPublishOrWSDispatch(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, _ := os.ReadFile(f)
		for _, banned := range []string{"nc.Publish(", "js.Publish(", "publishTask", `Action == "dispatch"`, `cmd.Action == "dispatch"`} {
			if strings.Contains(string(b), banned) {
				t.Errorf("%s contains %q", f, banned)
			}
		}
	}
	b, _ := os.ReadFile("main.go")
	if strings.Contains(string(b), `"dispatch"`) {
		t.Error("wsHandler must not handle a dispatch action")
	}
}

func TestChainSummaryInvokableLabel(t *testing.T) {
	mk := func(labels map[string]interface{}) map[string]interface{} {
		return map[string]interface{}{"metadata": map[string]interface{}{"name": "c", "namespace": "ns", "labels": labels}}
	}
	if c := parseChainResource(mk(map[string]interface{}{"ai.roundtable.io/invokable": "true"}), nil); !c.Invokable {
		t.Error("labelled chain must be invokable")
	}
	if c := parseChainResource(mk(map[string]interface{}{"ai.roundtable.io/invokable": "false"}), nil); c.Invokable {
		t.Error("false label must not be invokable")
	}
	if c := parseChainResource(mk(nil), nil); c.Invokable {
		t.Error("no label must not be invokable")
	}
}

func TestChainRunCancelRelaysReason(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		w.WriteHeader(http.StatusConflict)
		io.WriteString(w, `{"error":"run already finished"}`)
	}}
	srv := f.server(t)
	r := dispatchRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})
	w := doReq(r, "POST", "/api/chains/runs/ns/run-1/cancel", `{"reason":"x","other":1}`)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "run already finished") {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	c := f.calls[0]
	if c.method != "POST" || c.path != "/v1/runs/ns/run-1/cancel" || c.auth != "Bearer tok" {
		t.Errorf("gateway call %+v", c)
	}
	var body map[string]interface{}
	json.Unmarshal([]byte(c.body), &body)
	if body["reason"] != "x" || len(body) != 1 {
		t.Errorf("gateway body %v", body)
	}
	// An empty body is allowed.
	if w := doReq(r, "POST", "/api/chains/runs/ns/run-1/cancel", ""); w.Code != http.StatusConflict {
		t.Errorf("empty body: %d", w.Code)
	}
}

func TestChainRunCancelValidation(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := dispatchRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	long, _ := json.Marshal(map[string]string{"reason": strings.Repeat("a", maxCancelReasonLen+1)})
	for name, c := range map[string][2]string{
		"bad namespace": {"/api/chains/runs/N%20s/run-1/cancel", `{}`},
		"bad run":       {"/api/chains/runs/ns/a%20b/cancel", `{}`},
		"bad json":      {"/api/chains/runs/ns/run-1/cancel", `{`},
		"long reason":   {"/api/chains/runs/ns/run-1/cancel", string(long)},
	} {
		if w := doReq(r, "POST", c[0], c[1]); w.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d", name, w.Code)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("invalid requests reached the gateway: %v", f.calls)
	}
}

func doReqKey(r http.Handler, target, body string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", target, strings.NewReader(body))
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestIdempotencyKeyForwarded(t *testing.T) {
	cases := []struct{ name, target, body string }{
		{"dispatch", "/api/tasks/dispatch", `{"knight":"galahad","task":"go"}`},
		{"chain run", "/api/chains/nightly/run", `{}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			// Fake gateway: the first call creates work, a repeat of the key replays.
			seen := map[string]bool{}
			created := 0
			f := &fakeGateway{}
			f.handler = func(call gwCall, w http.ResponseWriter) {
				if call.idem != "" && seen[call.idem] {
					w.Header().Set("Idempotent-Replay", "true")
				} else {
					created++
					seen[call.idem] = true
				}
				w.WriteHeader(http.StatusAccepted)
				io.WriteString(w, `{"taskId":"t1","runId":"run-1"}`)
			}
			srv := f.server(t)
			r := dispatchRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})
			h := map[string]string{"Idempotency-Key": " abc "}

			w1 := doReqKey(r, c.target, c.body, h)
			w2 := doReqKey(r, c.target, c.body, h)
			if w1.Code != 202 || w2.Code != 202 {
				t.Fatalf("got %d %d", w1.Code, w2.Code)
			}
			if f.calls[0].idem != "abc" || f.calls[1].idem != "abc" {
				t.Errorf("gateway keys %q %q", f.calls[0].idem, f.calls[1].idem)
			}
			if created != 1 {
				t.Errorf("work created %d times", created)
			}
			if w1.Header().Get("Idempotent-Replay") != "" || w2.Header().Get("Idempotent-Replay") != "true" {
				t.Errorf("replay headers %q %q", w1.Header().Get("Idempotent-Replay"), w2.Header().Get("Idempotent-Replay"))
			}

			// No header: nothing is sent.
			doReqKey(r, c.target, c.body, nil)
			if last := f.calls[len(f.calls)-1]; last.idem != "" {
				t.Errorf("unexpected key %q", last.idem)
			}
		})
	}
}

func TestIdempotencyKeyInvalid(t *testing.T) {
	for _, k := range []string{"   ", strings.Repeat("a", 256), "café", "a\x7fb", "a\tb"} {
		f := &fakeGateway{}
		srv := f.server(t)
		r := dispatchRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})
		for _, c := range [][2]string{
			{"/api/tasks/dispatch", `{"knight":"galahad","task":"go"}`},
			{"/api/chains/nightly/run", `{}`},
		} {
			w := doReqKey(r, c[0], c[1], map[string]string{"Idempotency-Key": k})
			if w.Code != http.StatusBadRequest {
				t.Errorf("key %q on %s: got %d", k, c[0], w.Code)
			}
		}
		if len(f.calls) != 0 {
			t.Errorf("key %q reached the gateway", k)
		}
	}
}

func TestGatewayRelayUpstreamMapping(t *testing.T) {
	gatewayWarnLast = time.Time{}
	cases := []struct {
		name       string
		status     int
		body       string
		retryAfter string
		wantStatus int
		wantSub    string
		wantRA     string
	}{
		{"401 is the dashboard's credential", 401, `{"error":"unauthorized"}`, "", 502, "GATEWAY_TOKEN", ""},
		{"403 auth middleware", 403, `{"error":"forbidden: service account not allowed"}`, "", 502, "GATEWAY_TOKEN", ""},
		{"403 feature stays 403", 403, `{"error":"snapshots disabled"}`, "", 403, "snapshots disabled", ""},
		{"429 keeps Retry-After", 429, `{"error":"slow down"}`, "7", 429, "slow down", "7"},
		{"503 keeps Retry-After", 503, `{"error":"busy"}`, "3", 503, "busy", "3"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
				w.Header().Set("WWW-Authenticate", "Bearer")
				if c.retryAfter != "" {
					w.Header().Set("Retry-After", c.retryAfter)
				}
				w.WriteHeader(c.status)
				io.WriteString(w, c.body)
			}}
			srv := f.server(t)
			r := dispatchRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
			w := doReq(r, "GET", "/api/tasks/dispatch/t1", "")
			if w.Code != c.wantStatus || !strings.Contains(w.Body.String(), c.wantSub) {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
			if got := w.Header().Get("Retry-After"); got != c.wantRA {
				t.Errorf("Retry-After = %q, want %q", got, c.wantRA)
			}
			if w.Header().Get("WWW-Authenticate") != "" {
				t.Error("WWW-Authenticate must not be forwarded")
			}
		})
	}
}

func TestGatewayRelayTransportFailures(t *testing.T) {
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	t.Cleanup(slow.Close)
	timeoutClient := &http.Client{Timeout: 50 * time.Millisecond}
	w := doReq(dispatchRouter(&gatewayClient{baseURL: slow.URL, http: timeoutClient}), "GET", "/api/tasks/dispatch/t1", "")
	if w.Code != http.StatusGatewayTimeout || !strings.Contains(w.Body.String(), "Gateway timed out") {
		t.Errorf("timeout: got %d %s", w.Code, w.Body)
	}

	dead := httptest.NewServer(http.NotFoundHandler())
	url := dead.URL
	dead.Close()
	w = doReq(dispatchRouter(&gatewayClient{baseURL: url, http: http.DefaultClient}), "GET", "/api/tasks/dispatch/t1", "")
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), "Gateway unreachable") {
		t.Errorf("refused: got %d %s", w.Code, w.Body)
	}
}
