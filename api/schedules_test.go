package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

func scheduleRouter(g *gatewayClient) *mux.Router {
	r := mux.NewRouter()
	scheduleRoutes(r.PathPrefix("/api").Subrouter(), g, func(h http.Handler) http.Handler { return h })
	return r
}

func TestSchedulesProxyEveryRoute(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		io.WriteString(w, `{"ok":true}`)
	}}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	createBody := `{"name":"morning-digest","spec":{"source":{"schedule":{"cron":"0 7 * * 1-5"}},"target":{"chainRef":{"name":"digest"}}}}`
	cases := []struct {
		method, target, body        string
		wantMethod, wantPath, wantQ string
		wantBody                    string
	}{
		{"GET", "/api/schedules?namespace=roundtable&table=fleet-a&bogus=1", "", "GET", "/v1/schedules", "namespace=roundtable&table=fleet-a", ""},
		{"GET", "/api/schedules?table=none", "", "GET", "/v1/schedules", "", ""},
		{"POST", "/api/schedules", createBody, "POST", "/v1/schedules", "", createBody},
		{"GET", "/api/schedules/roundtable/morning-digest", "", "GET", "/v1/schedules/roundtable/morning-digest", "", ""},
		{"PUT", "/api/schedules/roundtable/morning-digest", `{"spec":{}}`, "PUT", "/v1/schedules/roundtable/morning-digest", "", `{"spec":{}}`},
		{"DELETE", "/api/schedules/roundtable/morning-digest", "", "DELETE", "/v1/schedules/roundtable/morning-digest", "", ""},
		{"POST", "/api/schedules/roundtable/morning-digest/suspend", "", "POST", "/v1/schedules/roundtable/morning-digest/suspend", "", ""},
		{"POST", "/api/schedules/roundtable/morning-digest/resume", "", "POST", "/v1/schedules/roundtable/morning-digest/resume", "", ""},
		{"POST", "/api/schedules/roundtable/morning-digest/run", "", "POST", "/v1/schedules/roundtable/morning-digest/run", "", ""},
		{"GET", "/api/schedules/roundtable/morning-digest/runs?limit=50", "", "GET", "/v1/schedules/roundtable/morning-digest/runs", "limit=50", ""},
		{"GET", "/api/schedules/roundtable/morning-digest/runs/digest-1795600000", "", "GET", "/v1/schedules/roundtable/morning-digest/runs/digest-1795600000", "", ""},
	}
	for i, c := range cases {
		w := doReq(r, c.method, c.target, c.body)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"ok":true`) {
			t.Errorf("%s %s: got %d %s", c.method, c.target, w.Code, w.Body)
			continue
		}
		got := f.calls[i]
		if got.method != c.wantMethod || got.path != c.wantPath || got.query != c.wantQ || got.auth != "Bearer tok" || got.body != c.wantBody {
			t.Errorf("%s %s: gateway call %+v", c.method, c.target, got)
		}
	}
}

func TestSchedulesPassGatewayErrorsThrough(t *testing.T) {
	conflict := `{"error":"conflict: schedule roundtable/morning-digest is managed by Git: change it in Git (applied by Flux Kustomization flux-system/apps), not through the gateway","managedBy":"git"}`
	f := &fakeGateway{handler: func(c gwCall, w http.ResponseWriter) {
		switch {
		case c.method == "DELETE", c.method == "PUT":
			w.WriteHeader(http.StatusConflict)
			io.WriteString(w, conflict)
		case strings.HasSuffix(c.path, "/run"):
			w.WriteHeader(http.StatusConflict)
			io.WriteString(w, `{"state":"skipped","reason":"concurrency Forbid: run x is active"}`)
		case strings.HasSuffix(c.path, "/manifest"):
			w.Header().Set("Content-Type", "text/plain")
			w.WriteHeader(http.StatusNotFound)
			io.WriteString(w, "not found\n")
		default:
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":"invalid request: spec.source.schedule.cron: bad","field":"spec.source.schedule.cron"}`)
		}
	}}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})

	for _, m := range []string{"DELETE", "PUT"} {
		w := doReq(r, m, "/api/schedules/roundtable/morning-digest", `{"spec":{}}`)
		if w.Code != http.StatusConflict || w.Body.String() != conflict {
			t.Errorf("%s: got %d %s", m, w.Code, w.Body)
		}
	}
	w := doReq(r, "POST", "/api/schedules/roundtable/morning-digest/run", "")
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), `"state":"skipped"`) {
		t.Errorf("run: got %d %s", w.Code, w.Body)
	}
	w = doReq(r, "POST", "/api/schedules", `{"name":"x","spec":{}}`)
	var body map[string]string
	json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != http.StatusBadRequest || body["field"] != "spec.source.schedule.cron" {
		t.Errorf("create: got %d %s", w.Code, w.Body)
	}
	w = doReq(r, "GET", "/api/schedules/roundtable/morning-digest/manifest", "")
	json.Unmarshal(w.Body.Bytes(), &body)
	if w.Code != http.StatusNotFound || body["error"] != "not found" {
		t.Errorf("manifest error: got %d %s", w.Code, w.Body)
	}
}

func TestScheduleManifestIsYAML(t *testing.T) {
	yaml := "apiVersion: ai.roundtable.io/v1alpha1\nkind: Trigger\nmetadata:\n  name: morning-digest\n"
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/yaml")
		io.WriteString(w, yaml)
	}}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	w := doReq(r, "GET", "/api/schedules/roundtable/morning-digest/manifest", "")
	if w.Code != http.StatusOK || w.Body.String() != yaml {
		t.Fatalf("got %d %q", w.Code, w.Body)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/yaml") {
		t.Errorf("content type %q", ct)
	}
	if f.calls[0].path != "/v1/schedules/roundtable/morning-digest/manifest" {
		t.Errorf("gateway call %+v", f.calls[0])
	}
}

func TestSchedulesValidation(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	for _, c := range [][3]string{
		{"GET", "/api/schedules?namespace=a.b", ""},
		{"GET", "/api/schedules?table=fleet.>", ""},
		{"GET", "/api/schedules/roundtable/bad_name", ""},
		{"DELETE", "/api/schedules/9ns/x", ""},
		{"POST", "/api/schedules/roundtable/bad_name/run", ""},
		{"GET", "/api/schedules/roundtable/x/runs?limit=0", ""},
		{"GET", "/api/schedules/roundtable/x/runs?limit=201", ""},
		{"GET", "/api/schedules/roundtable/x/runs?limit=abc", ""},
		{"GET", "/api/schedules/roundtable/x/runs/-bad", ""},
		{"POST", "/api/schedules", `{`},
		{"POST", "/api/schedules", ``},
		{"PUT", "/api/schedules/roundtable/x", `not json`},
	} {
		if w := doReq(r, c[0], c[1], c[2]); w.Code != http.StatusBadRequest {
			t.Errorf("%s %s: got %d %s", c[0], c[1], w.Code, w.Body)
		}
	}
	if w := doReq(r, "POST", "/api/schedules", `{"input":"`+strings.Repeat("a", maxScheduleBody)+`"}`); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("large body: got %d", w.Code)
	}
	if len(f.calls) != 0 {
		t.Errorf("invalid requests reached the gateway: %v", f.calls)
	}
}

func TestSchedulesGatewayNotConfigured(t *testing.T) {
	r := scheduleRouter(&gatewayClient{http: http.DefaultClient})
	for _, c := range [][3]string{
		{"GET", "/api/schedules", ""},
		{"POST", "/api/schedules/roundtable/x/run", ""},
		{"GET", "/api/schedules/roundtable/x/manifest", ""},
	} {
		w := doReq(r, c[0], c[1], c[2])
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "Gateway not configured") {
			t.Errorf("%s %s: got %d %s", c[0], c[1], w.Code, w.Body)
		}
	}
}

func TestScheduleRunIsRateLimited(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := mux.NewRouter()
	wrapped := 0
	scheduleRoutes(r.PathPrefix("/api").Subrouter(), &gatewayClient{baseURL: srv.URL, http: srv.Client()},
		func(h http.Handler) http.Handler {
			wrapped++
			return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { jsonError(w, "slow down", http.StatusTooManyRequests) })
		})
	if wrapped != 1 {
		t.Fatalf("wrapped %d routes, want only run", wrapped)
	}
	if w := doReq(r, "POST", "/api/schedules/roundtable/x/run", ""); w.Code != http.StatusTooManyRequests {
		t.Errorf("run: got %d", w.Code)
	}
	if w := doReq(r, "POST", "/api/schedules/roundtable/x/suspend", ""); w.Code != http.StatusAccepted {
		t.Errorf("suspend: got %d", w.Code)
	}
}
