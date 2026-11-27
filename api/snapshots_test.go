package main

import (
	"io"
	"net/http"
	"testing"

	"github.com/gorilla/mux"
)

func snapshotRouter(g *gatewayClient) *mux.Router {
	r := mux.NewRouter()
	api := r.PathPrefix("/api").Subrouter()
	api.HandleFunc("/knights/{name}/snapshot", knightSnapshotHandler(g)).Methods("POST")
	api.HandleFunc("/knights/{name}/snapshots", knightSnapshotsHandler(g)).Methods("GET")
	return r
}

func TestKnightSnapshotRequestIsRelayed(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		w.WriteHeader(http.StatusAccepted)
		io.WriteString(w, `{"knight":"galahad","namespace":"roundtable","request":"req-1","expectedName":"snap-1","caller":"rt-ui"}`)
	}}
	srv := f.server(t)
	r := snapshotRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	w := doReq(r, "POST", "/api/knights/galahad/snapshot?namespace=roundtable&waitSeconds=30", "")
	if w.Code != http.StatusAccepted || w.Body.String() != `{"knight":"galahad","namespace":"roundtable","request":"req-1","expectedName":"snap-1","caller":"rt-ui"}` {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	c := f.calls[0]
	if c.method != "POST" || c.path != "/v1/knights/galahad/snapshot" || c.query != "namespace=roundtable" || c.auth != "Bearer tok" {
		t.Errorf("gateway call %+v", c)
	}
}

func TestKnightSnapshotListIsRelayed(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		io.WriteString(w, `{"knight":"galahad","snapshots":[{"name":"snap-1","readyToUse":true}]}`)
	}}
	srv := f.server(t)
	r := snapshotRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	w := doReq(r, "GET", "/api/knights/galahad/snapshots", "")
	if w.Code != http.StatusOK || w.Body.String() != `{"knight":"galahad","snapshots":[{"name":"snap-1","readyToUse":true}]}` {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	c := f.calls[0]
	if c.method != "GET" || c.path != "/v1/knights/galahad/snapshots" || c.query != "" {
		t.Errorf("gateway call %+v", c)
	}
}

func TestKnightSnapshotStatusesPassThrough(t *testing.T) {
	for _, status := range []int{http.StatusConflict, http.StatusUnprocessableEntity, http.StatusNotFound} {
		f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
			w.WriteHeader(status)
			io.WriteString(w, `{"error":"gateway said no"}`)
		}}
		srv := f.server(t)
		r := snapshotRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

		w := doReq(r, "POST", "/api/knights/galahad/snapshot?namespace=roundtable", "")
		if w.Code != status || w.Body.String() != `{"error":"gateway said no"}` {
			t.Errorf("status %d: got %d %s", status, w.Code, w.Body)
		}
	}
}

func TestKnightSnapshotRejectsBadInput(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := snapshotRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	for _, target := range []string{
		"/api/knights/-bad/snapshot",
		"/api/knights/galahad/snapshot?namespace=Bad_NS",
	} {
		if w := doReq(r, "POST", target, ""); w.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d", target, w.Code)
		}
	}
	if w := doReq(r, "GET", "/api/knights/-bad/snapshots", ""); w.Code != http.StatusBadRequest {
		t.Errorf("list with bad name: got %d", w.Code)
	}
	if len(f.calls) != 0 {
		t.Errorf("invalid input reached the gateway: %+v", f.calls)
	}
}
