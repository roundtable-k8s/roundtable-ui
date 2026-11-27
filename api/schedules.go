package main

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gorilla/mux"
	"sigs.k8s.io/yaml"
)

// Schedules (#300, part of #281) are Triggers with a schedule source. The
// dashboard API proxies every gateway schedules route (roundtable
// docs/gateway.md, "Schedules" and "Schedule run history") with the
// dashboard's gateway token. The gateway's status codes and error bodies are
// passed through unchanged, so a Git-managed schedule's 409 reaches the UI
// with its message and managedBy.

const maxScheduleBody = 1 << 20

// scheduleRoutes registers the schedule proxy on the /api subrouter. run is
// wrapped by wrapRun (the dispatch rate limit) because it starts work.
func scheduleRoutes(api *mux.Router, g *gatewayClient, wrapRun func(http.Handler) http.Handler) {
	api.HandleFunc("/schedules", scheduleListHandler(g)).Methods("GET")
	api.HandleFunc("/schedules", scheduleCreateHandler(g)).Methods("POST")
	api.HandleFunc("/schedules/{namespace}/{name}", scheduleGetHandler(g)).Methods("GET")
	api.HandleFunc("/schedules/{namespace}/{name}", scheduleUpdateHandler(g)).Methods("PUT")
	api.HandleFunc("/schedules/{namespace}/{name}", scheduleDeleteHandler(g)).Methods("DELETE")
	api.HandleFunc("/schedules/{namespace}/{name}/manifest", scheduleManifestHandler(g)).Methods("GET")
	api.HandleFunc("/schedules/{namespace}/{name}/suspend", scheduleActionHandler(g, "suspend")).Methods("POST")
	api.HandleFunc("/schedules/{namespace}/{name}/resume", scheduleActionHandler(g, "resume")).Methods("POST")
	api.Handle("/schedules/{namespace}/{name}/run", wrapRun(scheduleActionHandler(g, "run"))).Methods("POST")
	api.HandleFunc("/schedules/{namespace}/{name}/runs", scheduleRunsHandler(g)).Methods("GET")
	api.HandleFunc("/schedules/{namespace}/{name}/runs/{run}", scheduleRunResultHandler(g)).Methods("GET")
	api.HandleFunc("/schedules/{namespace}/{name}/next", scheduleNextHandler(g)).Methods("GET")
	api.HandleFunc("/schedules/preview", schedulePreviewHandler(g)).Methods("GET")
}

// scheduleCountQuery validates the optional ?count= of the next-fire-times
// routes: a positive integer is forwarded, anything else is a 400 (the
// gateway applies its own maximum of 50).
func scheduleCountQuery(w http.ResponseWriter, r *http.Request) (url.Values, bool) {
	q := url.Values{}
	if c := r.URL.Query().Get("count"); c != "" {
		n, err := strconv.Atoi(c)
		if err != nil || n < 1 {
			jsonError(w, "count must be a positive integer", http.StatusBadRequest)
			return nil, false
		}
		q.Set("count", strconv.Itoa(n))
	}
	return q, true
}

// scheduleNextHandler proxies GET /v1/schedules/{namespace}/{name}/next?count=.
func scheduleNextHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := schedulePath(w, r)
		if !ok {
			return
		}
		q, ok := scheduleCountQuery(w, r)
		if !ok {
			return
		}
		g.relay(w, r, http.MethodGet, p+"/next", q, nil)
	}
}

// schedulePreviewHandler proxies GET /v1/schedules/preview?cron=&timeZone=&count=.
// The cron expression is required (at most 256 characters) and timeZone is
// optional (at most 64 characters). The gateway's 422 for a bad cron or zone
// is relayed with its message.
func schedulePreviewHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cron := r.URL.Query().Get("cron")
		if cron == "" || len(cron) > 256 {
			jsonError(w, "cron is required (at most 256 characters)", http.StatusBadRequest)
			return
		}
		tz := r.URL.Query().Get("timeZone")
		if len(tz) > 64 {
			jsonError(w, "timeZone must be at most 64 characters", http.StatusBadRequest)
			return
		}
		q, ok := scheduleCountQuery(w, r)
		if !ok {
			return
		}
		q.Set("cron", cron)
		if tz != "" {
			q.Set("timeZone", tz)
		}
		g.relay(w, r, http.MethodGet, "/v1/schedules/preview", q, nil)
	}
}

// schedulePath validates {namespace}/{name} and returns the gateway path
// /v1/schedules/{namespace}/{name}. ok is false after a 400 was written.
func schedulePath(w http.ResponseWriter, r *http.Request) (string, bool) {
	v := mux.Vars(r)
	if !validK8sName.MatchString(v["namespace"]) || !validK8sName.MatchString(v["name"]) {
		jsonError(w, "Invalid namespace or schedule name", http.StatusBadRequest)
		return "", false
	}
	return "/v1/schedules/" + url.PathEscape(v["namespace"]) + "/" + url.PathEscape(v["name"]), true
}

// readScheduleBody reads a JSON request body (at most 1 MiB) to forward as
// is: the gateway validates the schedule and rejects unknown fields.
func readScheduleBody(w http.ResponseWriter, r *http.Request) ([]byte, bool) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxScheduleBody))
	if err != nil {
		jsonError(w, "Request body too large", http.StatusRequestEntityTooLarge)
		return nil, false
	}
	if len(strings.TrimSpace(string(b))) == 0 || !json.Valid(b) {
		jsonError(w, "Invalid request", http.StatusBadRequest)
		return nil, false
	}
	return b, true
}

// scheduleListHandler proxies GET /v1/schedules?namespace=&table=.
func scheduleListHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := url.Values{}
		if ns := r.URL.Query().Get("namespace"); ns != "" {
			if !validK8sName.MatchString(ns) {
				jsonError(w, "Invalid namespace", http.StatusBadRequest)
				return
			}
			q.Set("namespace", ns)
		}
		// "none" (no RoundTable) is the dashboard's own filter value; the
		// gateway has no such table, so the UI narrows to it itself.
		if t := tableFilter(r); t != "" && t != tableNone {
			if !validK8sName.MatchString(t) {
				jsonError(w, "Invalid table", http.StatusBadRequest)
				return
			}
			q.Set("table", t)
		}
		g.relay(w, r, http.MethodGet, "/v1/schedules", q, nil)
	}
}

// scheduleCreateHandler proxies POST /v1/schedules.
func scheduleCreateHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, ok := readScheduleBody(w, r)
		if !ok {
			return
		}
		g.relay(w, r, http.MethodPost, "/v1/schedules", nil, body)
	}
}

// scheduleGetHandler proxies GET /v1/schedules/{namespace}/{name}.
func scheduleGetHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := schedulePath(w, r)
		if !ok {
			return
		}
		g.relay(w, r, http.MethodGet, p, nil, nil)
	}
}

// scheduleUpdateHandler proxies PUT /v1/schedules/{namespace}/{name}.
func scheduleUpdateHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := schedulePath(w, r)
		if !ok {
			return
		}
		body, ok := readScheduleBody(w, r)
		if !ok {
			return
		}
		g.relay(w, r, http.MethodPut, p, nil, body)
	}
}

// scheduleDeleteHandler proxies DELETE /v1/schedules/{namespace}/{name}.
func scheduleDeleteHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := schedulePath(w, r)
		if !ok {
			return
		}
		g.relay(w, r, http.MethodDelete, p, nil, nil)
	}
}

// scheduleActionHandler proxies POST /v1/schedules/{namespace}/{name}/{action}
// for suspend, resume and run. None of them takes a body.
func scheduleActionHandler(g *gatewayClient, action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := schedulePath(w, r)
		if !ok {
			return
		}
		g.relay(w, r, http.MethodPost, p+"/"+action, nil, nil)
	}
}

// scheduleRunsHandler proxies GET /v1/schedules/{namespace}/{name}/runs?limit=.
func scheduleRunsHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := schedulePath(w, r)
		if !ok {
			return
		}
		q := url.Values{}
		if l := r.URL.Query().Get("limit"); l != "" {
			if n, err := strconv.Atoi(l); err != nil || n < 1 || n > 200 {
				jsonError(w, "limit must be 1-200", http.StatusBadRequest)
				return
			}
			q.Set("limit", l)
		}
		g.relay(w, r, http.MethodGet, p+"/runs", q, nil)
	}
}

// scheduleRunResultHandler proxies GET /v1/schedules/{namespace}/{name}/runs/{run}.
func scheduleRunResultHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := schedulePath(w, r)
		if !ok {
			return
		}
		run := mux.Vars(r)["run"]
		if !validTaskID.MatchString(run) {
			jsonError(w, "Invalid run", http.StatusBadRequest)
			return
		}
		g.relay(w, r, http.MethodGet, p+"/runs/"+url.PathEscape(run), nil, nil)
	}
}

// scheduleManifestHandler proxies GET /v1/schedules/{namespace}/{name}/manifest.
// A success is YAML and is passed through as application/yaml; an error is
// relayed as JSON like every other route. With ?format=json the manifest is
// converted to JSON: the edit form (#302) starts from it, so a schedule it
// does not change keeps every field the manifest has.
func scheduleManifestHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := schedulePath(w, r)
		if !ok {
			return
		}
		format := r.URL.Query().Get("format")
		if format != "" && format != "yaml" && format != "json" {
			jsonError(w, "format must be yaml or json", http.StatusBadRequest)
			return
		}
		if g.baseURL == "" {
			jsonError(w, "Gateway not configured (set GATEWAY_URL)", http.StatusServiceUnavailable)
			return
		}
		status, b, err := g.do(r.Context(), routeLabel(r), http.MethodGet, p+"/manifest", nil, nil)
		if errors.Is(err, errGatewayBodyTooLarge) {
			slog.WarnContext(r.Context(), "gateway response over relay limit", "path", p+"/manifest", "limit_bytes", gatewayMaxBody)
			jsonError(w, "Gateway response too large", http.StatusBadGateway)
			return
		}
		if err != nil {
			slog.ErrorContext(r.Context(), "gateway request failed", "path", p+"/manifest", "error", err)
			jsonError(w, "Gateway unreachable", http.StatusBadGateway)
			return
		}
		if status != http.StatusOK {
			writeGatewayResponse(w, status, b)
			return
		}
		if format == "json" {
			j, err := yaml.YAMLToJSON(b)
			if err != nil {
				slog.ErrorContext(r.Context(), "gateway manifest is not YAML", "path", p+"/manifest", "error", err)
				jsonError(w, "Gateway returned an invalid manifest", http.StatusBadGateway)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(j)
			return
		}
		w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b)
	}
}

// writeGatewayResponse relays a gateway answer (success or error): a JSON body as is, any
// other body wrapped in {"error": ...}.
func writeGatewayResponse(w http.ResponseWriter, status int, b []byte) {
	if json.Valid(b) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.WriteHeader(status)
		_, _ = w.Write(b)
		return
	}
	msg := strings.TrimSpace(string(b))
	if len(msg) > 300 {
		msg = msg[:300]
	}
	if msg == "" {
		msg = http.StatusText(status)
	}
	jsonError(w, msg, status)
}
