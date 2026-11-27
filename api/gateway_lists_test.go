package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

func gatewayListRouter(t *testing.T, status int, resp string) (*mux.Router, *[]gwCall) {
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
	r.HandleFunc("/api/gateway/tasks", gatewayTasksHandler(g)).Methods("GET")
	r.HandleFunc("/api/gateway/runs", gatewayRunsHandler(g)).Methods("GET")
	return r, &calls
}

func TestGatewayTasksList(t *testing.T) {
	r, calls := gatewayListRouter(t, 200, `{"tasks":[{"taskId":"t1"}]}`)
	w := doReq(r, "GET", "/api/gateway/tasks?knight=galahad&limit=5&status=running&runId=run-1&bogus=1", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"t1"`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	c := (*calls)[0]
	if c.path != "/v1/tasks" || c.auth != "Bearer tok" {
		t.Fatalf("gateway call %+v", c)
	}
	if c.query != "knight=galahad&limit=5&runId=run-1&status=running" {
		t.Errorf("query = %q", c.query)
	}
}

func TestGatewayRunsList(t *testing.T) {
	r, calls := gatewayListRouter(t, 200, `{"runs":[]}`)
	if w := doReq(r, "GET", "/api/gateway/runs?chain=x&phase=Succeeded&namespace=ns1", ""); w.Code != 200 {
		t.Fatalf("got %d", w.Code)
	}
	c := (*calls)[0]
	if c.path != "/v1/runs" || c.query != "chain=x&namespace=ns1&phase=Succeeded" {
		t.Errorf("gateway call %+v", c)
	}
}

func TestGatewayRunsListSourceActiveIssue(t *testing.T) {
	r, calls := gatewayListRouter(t, 200, `{"runs":[]}`)
	if w := doReq(r, "GET", "/api/gateway/runs?source=all&active=true&issue=acme%2Fapp%2312&bogus=1", ""); w.Code != 200 {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	c := (*calls)[0]
	if c.path != "/v1/runs" || c.query != "active=true&issue=acme%2Fapp%2312&source=all" {
		t.Errorf("gateway call %+v", c)
	}
}

func TestGatewayRunsListRejectsBadFilters(t *testing.T) {
	cases := map[string]string{
		"/api/gateway/runs?source=nope":                   "Invalid source",
		"/api/gateway/runs?source=ALL":                    "Invalid source",
		"/api/gateway/runs?active=1":                      "active must be true",
		"/api/gateway/runs?active=false":                  "active must be true",
		"/api/gateway/runs?issue=x":                       "Invalid issue",
		"/api/gateway/runs?issue=acme%2Fapp":              "Invalid issue",
		"/api/gateway/runs?issue=acme%2Fapp%23abc":        "Invalid issue",
		"/api/gateway/runs?issue=acme%2Fapp%231234567890": "Invalid issue",
	}
	for target, msg := range cases {
		r, calls := gatewayListRouter(t, 200, `{}`)
		w := doReq(r, "GET", target, "")
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), msg) {
			t.Errorf("%s: got %d %s", target, w.Code, w.Body)
		}
		if len(*calls) != 0 {
			t.Errorf("%s reached the gateway", target)
		}
	}
}

func TestGatewayListsRejectBadInput(t *testing.T) {
	cases := map[string]string{
		"/api/gateway/tasks?knight=-bad":       "Invalid knight name",
		"/api/gateway/tasks?limit=0":           "limit must be a positive integer",
		"/api/gateway/tasks?limit=abc":         "limit must be a positive integer",
		"/api/gateway/tasks?status=run%20ning": "Invalid status",
		"/api/gateway/tasks?runId=a/b":         "Invalid run ID",
		"/api/gateway/runs?chain=Bad_Name":     "Invalid chain name",
		"/api/gateway/runs?namespace=A":        "Invalid namespace",
		"/api/gateway/runs?phase=1x":           "Invalid phase",
		"/api/gateway/runs?limit=-3":           "limit must be a positive integer",
	}
	for target, msg := range cases {
		r, calls := gatewayListRouter(t, 200, `{}`)
		w := doReq(r, "GET", target, "")
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), msg) {
			t.Errorf("%s: got %d %s", target, w.Code, w.Body)
		}
		if len(*calls) != 0 {
			t.Errorf("%s reached the gateway", target)
		}
	}
}

func TestGatewayListsPassThroughGatewayErrors(t *testing.T) {
	r, _ := gatewayListRouter(t, 503, `{"error":"store unavailable"}`)
	if w := doReq(r, "GET", "/api/gateway/tasks", ""); w.Code != 503 || !strings.Contains(w.Body.String(), "store unavailable") {
		t.Errorf("tasks: got %d %s", w.Code, w.Body)
	}
	if w := doReq(r, "GET", "/api/gateway/runs", ""); w.Code != 503 || !strings.Contains(w.Body.String(), "store unavailable") {
		t.Errorf("runs: got %d %s", w.Code, w.Body)
	}

	unconfigured := mux.NewRouter()
	g := &gatewayClient{}
	unconfigured.HandleFunc("/api/gateway/tasks", gatewayTasksHandler(g)).Methods("GET")
	if w := doReq(unconfigured, "GET", "/api/gateway/tasks", ""); w.Code != 503 || !strings.Contains(w.Body.String(), "Gateway not configured") {
		t.Errorf("unconfigured: got %d %s", w.Code, w.Body)
	}
}
