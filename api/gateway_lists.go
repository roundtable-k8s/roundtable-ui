package main

import (
	"net/http"
	"net/url"
	"regexp"
	"strconv"
)

// validStateWord guards the status and phase filters forwarded to the gateway.
var validStateWord = regexp.MustCompile(`^[A-Za-z]+$`)

// gatewayListMax is the largest limit the gateway honours for /v1/tasks and /v1/runs.
const gatewayListMax = 200

// listLimit reads the optional limit query value. It must be a positive integer;
// values above maxLimit are clamped to it. An absent value is left to the
// gateway's default.
func listLimit(w http.ResponseWriter, r *http.Request, q url.Values, maxLimit int) bool {
	l := r.URL.Query().Get("limit")
	if l == "" {
		return true
	}
	n, err := strconv.Atoi(l)
	if err != nil || n < 1 {
		jsonError(w, "limit must be a positive integer", http.StatusBadRequest)
		return false
	}
	if n > maxLimit {
		n = maxLimit
	}
	q.Set("limit", strconv.Itoa(n))
	return true
}

// deadLetterListMax is the largest limit the gateway honours for /v1/dead-letters.
const deadLetterListMax = 100

// validTaskStateQuery checks the optional query value key against re and copies
// it to q. It answers 400 with msg and returns false when the value is invalid.
func validTaskStateQuery(w http.ResponseWriter, r *http.Request, q url.Values, key string, re *regexp.Regexp, msg string) bool {
	v := r.URL.Query().Get(key)
	if v == "" {
		return true
	}
	if !re.MatchString(v) {
		jsonError(w, msg, http.StatusBadRequest)
		return false
	}
	q.Set(key, v)
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
		if !listLimit(w, r, q, gatewayListMax) {
			return
		}
		g.relay(w, r, http.MethodGet, "/v1/tasks", q, nil)
	}
}

// validRunSource lists the values the gateway accepts for the runs source filter.
var validRunSource = map[string]bool{"gateway": true, "trigger": true, "pickup": true, "all": true}

// validRunIssue matches the owner/repo#number form of a picked-up issue.
var validRunIssue = regexp.MustCompile(`^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]{1,9}$`)

// gatewayRunsHandler proxies GET /v1/runs (namespace, chain, phase, source,
// active, issue, limit). Other query keys are dropped.
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
		if s := r.URL.Query().Get("source"); s != "" {
			if !validRunSource[s] {
				jsonError(w, "Invalid source", http.StatusBadRequest)
				return
			}
			q.Set("source", s)
		}
		if a := r.URL.Query().Get("active"); a != "" {
			if a != "true" {
				jsonError(w, "active must be true", http.StatusBadRequest)
				return
			}
			q.Set("active", a)
		}
		if is := r.URL.Query().Get("issue"); is != "" {
			if !validRunIssue.MatchString(is) {
				jsonError(w, "Invalid issue", http.StatusBadRequest)
				return
			}
			q.Set("issue", is)
		}
		if !listLimit(w, r, q, gatewayListMax) {
			return
		}
		g.relay(w, r, http.MethodGet, "/v1/runs", q, nil)
	}
}
