package main

import (
	"net/http"
	"net/url"

	"github.com/gorilla/mux"
)

// knightSnapshotHandler proxies POST /v1/knights/{name}/snapshot?namespace=.
// waitSeconds is deliberately not forwarded: a waiting gateway call would hold
// a gateway slot. The gateway answers 202 at once; 409, 422 and 404 pass through.
func knightSnapshotHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name, q, ok := knightSnapshotTarget(w, r)
		if !ok {
			return
		}
		g.relay(w, r, http.MethodPost, "/v1/knights/"+url.PathEscape(name)+"/snapshot", q, nil)
	}
}

// knightSnapshotsHandler proxies GET /v1/knights/{name}/snapshots?namespace=.
func knightSnapshotsHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name, q, ok := knightSnapshotTarget(w, r)
		if !ok {
			return
		}
		g.relay(w, r, http.MethodGet, "/v1/knights/"+url.PathEscape(name)+"/snapshots", q, nil)
	}
}

// knightSnapshotTarget validates the knight name and the optional namespace
// and returns the name plus the query to forward. ok is false after a 400.
func knightSnapshotTarget(w http.ResponseWriter, r *http.Request) (string, url.Values, bool) {
	name := mux.Vars(r)["name"]
	if !validKnightName.MatchString(name) {
		jsonError(w, "Invalid knight name", http.StatusBadRequest)
		return "", nil, false
	}
	q := url.Values{}
	if ns := r.URL.Query().Get("namespace"); ns != "" {
		if !validK8sName.MatchString(ns) {
			jsonError(w, "Invalid namespace", http.StatusBadRequest)
			return "", nil, false
		}
		q.Set("namespace", ns)
	}
	return name, q, true
}
