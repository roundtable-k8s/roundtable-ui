package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"

	"github.com/gorilla/mux"
)

// Dispatch and run-now go through the invoke gateway (whiteboard decision 6),
// which resolves each knight's table and prefix and validates the model. The
// dashboard API never publishes task messages itself.

const maxDispatchTaskLen = 10000

// dispatchRequest is the body of POST /api/tasks/dispatch.
type dispatchRequest struct {
	Knight    string `json:"knight"`
	Task      string `json:"task"`
	Model     string `json:"model,omitempty"`
	RunID     string `json:"runId,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

// taskDispatchHandler proxies POST /v1/knights/{knight}/invoke with
// timeoutSeconds 0: the gateway returns the task record (taskId, runId) at
// once and the UI polls GET /api/tasks/dispatch/{taskId}.
func taskDispatchHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req dispatchRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
			jsonError(w, "Invalid request", http.StatusBadRequest)
			return
		}
		if !validKnightName.MatchString(req.Knight) {
			jsonError(w, "Invalid knight name", http.StatusBadRequest)
			return
		}
		if len(req.Task) == 0 || len(req.Task) > maxDispatchTaskLen {
			jsonError(w, "Task must be 1-10000 characters", http.StatusBadRequest)
			return
		}
		if req.RunID != "" && !validTaskID.MatchString(req.RunID) {
			jsonError(w, "Invalid run ID", http.StatusBadRequest)
			return
		}
		if len(req.Model) > 200 {
			jsonError(w, "Invalid model", http.StatusBadRequest)
			return
		}
		if req.Namespace != "" && !validKnightName.MatchString(req.Namespace) {
			jsonError(w, "Invalid namespace", http.StatusBadRequest)
			return
		}
		body, _ := json.Marshal(map[string]interface{}{
			"task":           req.Task,
			"model":          req.Model,
			"runId":          req.RunID,
			"namespace":      req.Namespace,
			"timeoutSeconds": 0,
		})
		g.relay(w, r, http.MethodPost, "/v1/knights/"+url.PathEscape(req.Knight)+"/invoke", nil, body)
	}
}

// taskStatusHandler proxies GET /v1/tasks/{taskId}.
func taskStatusHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := mux.Vars(r)["taskId"]
		if !validTaskID.MatchString(id) {
			jsonError(w, "Invalid task ID", http.StatusBadRequest)
			return
		}
		g.relay(w, r, http.MethodGet, "/v1/tasks/"+url.PathEscape(id), nil, nil)
	}
}

// chainRunHandler proxies POST /v1/chains/{name}/runs with waitSeconds 0.
// The optional JSON "input" is passed through; the gateway only runs Chains
// labelled ai.roundtable.io/invokable=true.
func chainRunHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := mux.Vars(r)["name"]
		if !validKnightName.MatchString(name) {
			jsonError(w, "Invalid chain name", http.StatusBadRequest)
			return
		}
		var req struct {
			Input     json.RawMessage `json:"input,omitempty"`
			Namespace string          `json:"namespace,omitempty"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil && err != io.EOF {
			jsonError(w, "Invalid request", http.StatusBadRequest)
			return
		}
		if req.Namespace != "" && !validKnightName.MatchString(req.Namespace) {
			jsonError(w, "Invalid namespace", http.StatusBadRequest)
			return
		}
		body, _ := json.Marshal(map[string]interface{}{
			"input":       req.Input,
			"namespace":   req.Namespace,
			"waitSeconds": 0,
		})
		g.relay(w, r, http.MethodPost, "/v1/chains/"+url.PathEscape(name)+"/runs", nil, body)
	}
}

// chainRunStatusHandler proxies GET /v1/runs/{namespace}/{run}.
func chainRunStatusHandler(g *gatewayClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v := mux.Vars(r)
		if !validKnightName.MatchString(v["namespace"]) || !validTaskID.MatchString(v["run"]) {
			jsonError(w, "Invalid namespace or run", http.StatusBadRequest)
			return
		}
		g.relay(w, r, http.MethodGet, "/v1/runs/"+url.PathEscape(v["namespace"])+"/"+url.PathEscape(v["run"]), nil, nil)
	}
}
