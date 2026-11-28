package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

type gwCall struct {
	method, path, query, auth, body, idem string
}

func deadLetterRouter(t *testing.T, status int, resp string) (*mux.Router, *[]gwCall) {
	t.Helper()
	var calls []gwCall
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		calls = append(calls, gwCall{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), string(b), r.Header.Get("Idempotency-Key")})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, resp)
	}))
	t.Cleanup(gw.Close)
	g := &gatewayClient{baseURL: gw.URL, token: "tok", http: gw.Client()}
	r := mux.NewRouter()
	r.HandleFunc("/api/dead-letters", deadLettersHandler(g)).Methods("GET")
	r.HandleFunc("/api/dead-letters/{taskId}", deadLetterDetailHandler(g)).Methods("GET")
	r.HandleFunc("/api/dead-letters/{taskId}/retry", deadLetterRetryHandler(g)).Methods("POST")
	return r, &calls
}

func doReq(r http.Handler, method, target, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestDeadLettersList(t *testing.T) {
	r, calls := deadLetterRouter(t, 200, `{"deadLetters":[{"taskId":"t1"}]}`)
	w := doReq(r, "GET", "/api/dead-letters?knight=galahad&reason=lost&bogus=1", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"t1"`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	c := (*calls)[0]
	if c.path != "/v1/dead-letters" || c.query != "knight=galahad&reason=lost" || c.auth != "Bearer tok" {
		t.Errorf("gateway call %+v", c)
	}
}

func TestDeadLetterDetail(t *testing.T) {
	r, calls := deadLetterRouter(t, 200, `{"taskId":"t1","task":{"task":"do it"}}`)
	if w := doReq(r, "GET", "/api/dead-letters/t1?table=fleet-a", ""); w.Code != 200 {
		t.Fatalf("got %d", w.Code)
	}
	if c := (*calls)[0]; c.path != "/v1/dead-letters/t1" || c.query != "table=fleet-a" {
		t.Errorf("gateway call %+v", c)
	}
	if w := doReq(r, "GET", "/api/dead-letters/..%2Fx", ""); w.Code == 200 || len(*calls) != 1 {
		t.Errorf("bad id forwarded: %d", w.Code)
	}
}

func TestDeadLetterRetryPassThrough(t *testing.T) {
	tests := []struct {
		name   string
		status int
		resp   string
		body   string
		want   string
	}{
		{"success", 202, `{"taskId":"t1-r2","retryOf":"t1","attempt":2,"knight":"galahad"}`, `{}`, `"t1-r2"`},
		{"conflict", 409, `{"error":"dead letter t1 belongs to chain c","state":"open"}`, `{}`, "belongs to chain"},
		{"unprocessable", 422, `{"error":"no original task payload"}`, ``, "no original task payload"},
		{"not found", 404, `{"error":"dead letter not found"}`, `{"force":true}`, "not found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, calls := deadLetterRouter(t, tt.status, tt.resp)
			w := doReq(r, "POST", "/api/dead-letters/t1/retry", tt.body)
			if w.Code != tt.status || !strings.Contains(w.Body.String(), tt.want) {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
			if c := (*calls)[0]; c.method != "POST" || c.path != "/v1/dead-letters/t1/retry" {
				t.Errorf("gateway call %+v", c)
			}
		})
	}
}

func TestDeadLetterRetryForwardsForce(t *testing.T) {
	r, calls := deadLetterRouter(t, 202, `{}`)
	doReq(r, "POST", "/api/dead-letters/t1/retry", `{"force":true,"table":"fleet-a","namespace":"evil"}`)
	if got := (*calls)[0].body; got != `{"force":true,"table":"fleet-a"}` {
		t.Errorf("forwarded body %q", got)
	}
}

func TestDeadLetterGatewayProblems(t *testing.T) {
	r := mux.NewRouter()
	g := &gatewayClient{http: http.DefaultClient}
	r.HandleFunc("/api/dead-letters", deadLettersHandler(g))
	if w := doReq(r, "GET", "/api/dead-letters", ""); w.Code != 503 {
		t.Errorf("unconfigured: %d", w.Code)
	}
	g.baseURL = "http://127.0.0.1:1"
	if w := doReq(r, "GET", "/api/dead-letters", ""); w.Code != 502 {
		t.Errorf("unreachable: %d", w.Code)
	}
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(502)
		io.WriteString(w, "bad gateway")
	}))
	defer gw.Close()
	g.baseURL = gw.URL
	w := doReq(r, "GET", "/api/dead-letters", "")
	if w.Code != 502 || !strings.Contains(w.Body.String(), `"error":"bad gateway"`) {
		t.Errorf("non-json: %d %s", w.Code, w.Body)
	}
}

func TestDeadLetterGatewayBodyLimit(t *testing.T) {
	// A JSON string literal of exactly n bytes, so the body is valid JSON at any size.
	jsonOfSize := func(n int) string {
		return `"` + strings.Repeat("a", n-2) + `"`
	}
	tests := []struct {
		name     string
		size     int
		wantCode int
		want     string
	}{
		{"at limit is relayed", gatewayMaxBody, 200, strings.Repeat("a", 10)},
		{"over limit is 502", gatewayMaxBody + 1, 502, `"error":"Gateway response too large"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r, _ := deadLetterRouter(t, 200, jsonOfSize(tt.size))
			w := doReq(r, "GET", "/api/dead-letters", "")
			if w.Code != tt.wantCode || !strings.Contains(w.Body.String(), tt.want) {
				prefix := w.Body.String()
				if len(prefix) > 200 {
					prefix = prefix[:200]
				}
				t.Fatalf("got %d (%d bytes body), body prefix %q", w.Code, w.Body.Len(), prefix)
			}
			if tt.wantCode == 200 && w.Body.Len() != tt.size {
				t.Errorf("relayed %d bytes, want %d", w.Body.Len(), tt.size)
			}
		})
	}
}

func TestDeadLetterQueryValidation(t *testing.T) {
	for _, target := range []string{
		"/api/dead-letters?limit=abc",
		"/api/dead-letters?limit=0",
		"/api/dead-letters?state=open%3Bx",
		"/api/dead-letters?reason=a%20b",
		"/api/dead-letters?knight=bad%20name",
		"/api/dead-letters/t1?table=Bad_Table",
	} {
		r, calls := deadLetterRouter(t, 200, `{}`)
		w := doReq(r, "GET", target, "")
		if w.Code != 400 || !strings.Contains(w.Body.String(), `"error"`) {
			t.Errorf("%s: got %d %s", target, w.Code, w.Body)
		}
		if len(*calls) != 0 {
			t.Errorf("%s reached the gateway", target)
		}
	}
}

func TestDeadLettersLimitClamped(t *testing.T) {
	r, calls := deadLetterRouter(t, 200, `{}`)
	if w := doReq(r, "GET", "/api/dead-letters?limit=1000&state=open&knight=galahad", ""); w.Code != 200 {
		t.Fatalf("got %d", w.Code)
	}
	if q := (*calls)[0].query; q != "knight=galahad&limit=100&state=open" {
		t.Errorf("query = %q", q)
	}
}
