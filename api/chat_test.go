package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

func chatRouter(g *gatewayClient) *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/api/chat/{knight}", chatSendHandler(g)).Methods("POST")
	r.HandleFunc("/api/chat/knights", chatKnightsHandler(g)).Methods("GET")
	r.HandleFunc("/api/chat/tasks/{taskId}", taskStatusHandler(g)).Methods("GET")
	r.HandleFunc("/api/chat/tasks/{taskId}/events", chatEventsHandler(g)).Methods("GET")
	return r
}

func TestChatTwoTurnsKeepRunID(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := chatRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	// First turn: no runId is sent, the gateway picks one.
	w := doReq(r, "POST", "/api/chat/galahad", `{"message":"hello","model":"opus"}`)
	if w.Code != http.StatusAccepted || !strings.Contains(w.Body.String(), `"runId":"run-1"`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	var b1 map[string]interface{}
	json.Unmarshal([]byte(f.calls[0].body), &b1)
	if f.calls[0].path != "/v1/knights/galahad/invoke" || f.calls[0].auth != "Bearer tok" ||
		b1["task"] != "hello" || b1["model"] != "opus" || b1["timeoutSeconds"] != float64(0) {
		t.Errorf("first call %+v", f.calls[0])
	}
	if _, ok := b1["runId"]; ok {
		t.Error("first turn must not send a runId")
	}

	// Follow-up: the runId continues the conversation.
	w = doReq(r, "POST", "/api/chat/galahad", `{"message":"again","runId":"run-1"}`)
	if w.Code != http.StatusAccepted {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	var b2 map[string]interface{}
	json.Unmarshal([]byte(f.calls[1].body), &b2)
	if b2["runId"] != "run-1" || b2["task"] != "again" {
		t.Errorf("second body %v", b2)
	}
}

func TestChatValidation(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := chatRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	for name, c := range map[string][2]string{
		"empty":      {"/api/chat/galahad", `{"message":""}`},
		"bad run id": {"/api/chat/galahad", `{"message":"x","runId":"a/b"}`},
		"bad knight": {"/api/chat/fleet.%3E", `{"message":"x"}`},
		"bad json":   {"/api/chat/galahad", `{`},
	} {
		if w := doReq(r, "POST", c[0], c[1]); w.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d", name, w.Code)
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("invalid requests reached the gateway: %v", f.calls)
	}
}

func TestChatGatewayNotConfigured(t *testing.T) {
	r := chatRouter(&gatewayClient{http: http.DefaultClient})
	for _, c := range [][3]string{
		{"POST", "/api/chat/galahad", `{"message":"x"}`},
		{"GET", "/api/chat/knights", ""},
		{"GET", "/api/chat/tasks/t1", ""},
		{"GET", "/api/chat/tasks/t1/events", ""},
	} {
		w := doReq(r, c[0], c[1], c[2])
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "Gateway not configured") {
			t.Errorf("%s %s: got %d %s", c[0], c[1], w.Code, w.Body)
		}
	}
}

func TestChatKnightsAndTask(t *testing.T) {
	f := &fakeGateway{handler: func(c gwCall, w http.ResponseWriter) {
		io.WriteString(w, `{"ok":true}`)
	}}
	srv := f.server(t)
	r := chatRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	if w := doReq(r, "GET", "/api/chat/knights", ""); w.Code != 200 {
		t.Fatalf("knights %d", w.Code)
	}
	if w := doReq(r, "GET", "/api/chat/tasks/t1", ""); w.Code != 200 {
		t.Fatalf("task %d", w.Code)
	}
	if f.calls[0].path != "/v1/knights" || f.calls[1].path != "/v1/tasks/t1" {
		t.Errorf("calls %+v", f.calls)
	}
}

func TestChatEventsStreamsAndFallsBack(t *testing.T) {
	f := &fakeGateway{handler: func(c gwCall, w http.ResponseWriter) {
		if c.path == "/v1/tasks/t1/events" {
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "event: tool\ndata: {\"name\":\"bash\"}\n\n")
			return
		}
		w.WriteHeader(http.StatusNotFound)
		io.WriteString(w, `{"error":"not found"}`)
	}}
	srv := f.server(t)
	r := chatRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	w := doReq(r, "GET", "/api/chat/tasks/t1/events", "")
	if w.Code != 200 || w.Header().Get("Content-Type") != "text/event-stream" ||
		!strings.Contains(w.Body.String(), `data: {"name":"bash"}`) {
		t.Fatalf("got %d %q %s", w.Code, w.Header().Get("Content-Type"), w.Body)
	}
	if f.calls[0].auth != "Bearer tok" {
		t.Errorf("auth %q", f.calls[0].auth)
	}
	// 404 from the gateway is relayed as JSON so the UI polls instead.
	w = doReq(r, "GET", "/api/chat/tasks/t2/events", "")
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "error") {
		t.Errorf("got %d %s", w.Code, w.Body)
	}
}
