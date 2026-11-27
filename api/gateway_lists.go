package main

import (
	"net/http"
	"net/url"
	"regexp"
	"strconv"
)

// validStateWord guards the status and phase filters forwarded to the gateway.
var validStateWord = regexp.MustCompile(`^[A-Za-z]+$`)

// listLimit reads the optional limit query value. It must be a positive integer;
// an absent value is left to the gateway's default.
func listLimit(w http.ResponseWriter, r *http.Request, q url.Values) bool {
	l := r.URL.Query().Get("limit")
	if l == "" {
		return true
	}
	if n, err := strconv.Atoi(l); err != nil || n < 1 {
		jsonError(w, "limit must be a positive integer", http.StatusBadRequest)
		return false
	}
	q.Set("limit", l)
	return true
}

// gatewayTasksHandler proxies GET /v1/tasks (knight, runId, status, limit),
// newest first. Other query keys are dropped.
func gatewayTasksHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := url.Values{}
		if k := r.URL.Query().Get("knight"); k != "" {
			if !validKnightName.MatchString(k) {
				jsonError(w, "Invalid knight name", http.StatusBadRequest)
				return
			}
			q.Set("knight", k)
		}
		if id := r.URL.Query().Get("runId"); id != "" {
			if !validTaskID.MatchString(id) {
				jsonError(w, "Invalid run ID", http.StatusBadRequest)
				return
			}
			q.Set("runId", id)
		}
		if s := r.URL.Query().Get("status"); s != "" {
			if !validStateWord.MatchString(s) {
				jsonError(w, "Invalid status", http.StatusBadRequest)
				return
			}
			q.Set("status", s)
		}
		if !listLimit(w, r, q) {
			return
		}
		g.relay(w, r, http.MethodGet, "/v1/tasks", q, nil)
	}
}

// gatewayRunsHandler proxies GET /v1/runs (namespace, chain, phase, limit).
func gatewayRunsHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := url.Values{}
		if ns := r.URL.Query().Get("namespace"); ns != "" {
			if !validK8sName.MatchString(ns) {
				jsonError(w, "Invalid namespace", http.StatusBadRequest)
				return
			}
			q.Set("namespace", ns)
		}
		if c := r.URL.Query().Get("chain"); c != "" {
			if !validK8sName.MatchString(c) {
				jsonError(w, "Invalid chain name", http.StatusBadRequest)
				return
			}
			q.Set("chain", c)
		}
		if p := r.URL.Query().Get("phase"); p != "" {
			if !validStateWord.MatchString(p) {
				jsonError(w, "Invalid phase", http.StatusBadRequest)
				return
			}
			q.Set("phase", p)
		}
		if !listLimit(w, r, q) {
			return
		}
		g.relay(w, r, http.MethodGet, "/v1/runs", q, nil)
	}
}
