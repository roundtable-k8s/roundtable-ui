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
		{"GET", "/api/schedules/roundtable/morning-digest/next?count=3", "", "GET", "/v1/schedules/roundtable/morning-digest/next", "count=3", ""},
		{"GET", "/api/schedules/roundtable/morning-digest/next", "", "GET", "/v1/schedules/roundtable/morning-digest/next", "", ""},
		{"GET", "/api/schedules/preview?cron=0+7+*+*+1-5&timeZone=Europe/Berlin&count=2", "", "GET", "/v1/schedules/preview", "count=2&cron=0+7+%2A+%2A+1-5&timeZone=Europe%2FBerlin", ""},
		{"GET", "/api/schedules/preview?cron=@hourly", "", "GET", "/v1/schedules/preview", "cron=%40hourly", ""},
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
			io.WriteString(w, `{"state":"skipped","skipReason":"concurrency Forbid: run x is active"}`)
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

func TestSchedulePreviewRelaysGatewayErrors(t *testing.T) {
	msg := `{"error":"invalid cron expression \"0 7 * *\": expected 5 fields"}`
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		io.WriteString(w, msg)
	}}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	w := doReq(r, "GET", "/api/schedules/preview?cron=0+7+*+*", "")
	if w.Code != http.StatusUnprocessableEntity || w.Body.String() != msg {
		t.Errorf("got %d %s", w.Code, w.Body)
	}
	if len(f.calls) != 1 {
		t.Errorf("gateway calls: %d", len(f.calls))
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
		{"DELETE", "/api/schedules/Bad_ns/x", ""},
		{"POST", "/api/schedules/roundtable/bad_name/run", ""},
		{"GET", "/api/schedules/roundtable/x/runs?limit=0", ""},
		{"GET", "/api/schedules/roundtable/x/runs?limit=201", ""},
		{"GET", "/api/schedules/roundtable/x/runs?limit=abc", ""},
		{"GET", "/api/schedules/roundtable/x/runs/-bad", ""},
		{"GET", "/api/schedules/roundtable/bad_name/next?count=3", ""},
		{"GET", "/api/schedules/roundtable/x/next?count=x", ""},
		{"GET", "/api/schedules/roundtable/x/next?count=0", ""},
		{"GET", "/api/schedules/roundtable/x/next?count=-2", ""},
		{"GET", "/api/schedules/preview", ""},
		{"GET", "/api/schedules/preview?cron=", ""},
		{"GET", "/api/schedules/preview?cron=" + strings.Repeat("a", 257), ""},
		{"GET", "/api/schedules/preview?cron=0+7+*+*+1-5&timeZone=" + strings.Repeat("z", 65), ""},
		{"GET", "/api/schedules/preview?cron=0+7+*+*+1-5&count=abc", ""},
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

func TestScheduleManifestAsJSON(t *testing.T) {
	manifest := "apiVersion: ai.roundtable.io/v1alpha1\nkind: Trigger\nmetadata:\n  labels:\n    app.kubernetes.io/managed-by: roundtable-gateway\n  name: morning-digest\n  namespace: roundtable\nspec:\n  source:\n    schedule:\n      cron: 0 7 * * 1-5\n  target:\n    knight:\n      name: galahad\n      task: |-\n        line one\n        line two\n      timeoutSeconds: 3600\n"
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/yaml")
		io.WriteString(w, manifest)
	}}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})

	w := doReq(r, "GET", "/api/schedules/roundtable/morning-digest/manifest?format=json", "")
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("got %d %s %q", w.Code, w.Header().Get("Content-Type"), w.Body)
	}
	var got struct {
		Metadata struct {
			Name   string            `json:"name"`
			Labels map[string]string `json:"labels"`
		} `json:"metadata"`
		Spec struct {
			Source struct {
				Schedule struct {
					Cron string `json:"cron"`
				} `json:"schedule"`
			} `json:"source"`
			Target struct {
				Knight struct {
					Task           string `json:"task"`
					TimeoutSeconds int    `json:"timeoutSeconds"`
				} `json:"knight"`
			} `json:"target"`
		} `json:"spec"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Metadata.Name != "morning-digest" || got.Metadata.Labels["app.kubernetes.io/managed-by"] != "roundtable-gateway" ||
		got.Spec.Source.Schedule.Cron != "0 7 * * 1-5" || got.Spec.Target.Knight.Task != "line one\nline two" || got.Spec.Target.Knight.TimeoutSeconds != 3600 {
		t.Errorf("manifest as JSON: %+v", got)
	}
	// The gateway is asked for its YAML manifest; the query is not forwarded.
	if f.calls[0].path != "/v1/schedules/roundtable/morning-digest/manifest" || f.calls[0].query != "" {
		t.Errorf("gateway call %+v", f.calls[0])
	}

	w = doReq(r, "GET", "/api/schedules/roundtable/morning-digest/manifest?format=yaml", "")
	if w.Code != http.StatusOK || w.Body.String() != manifest {
		t.Errorf("format=yaml: got %d %q", w.Code, w.Body)
	}
	w = doReq(r, "GET", "/api/schedules/roundtable/morning-digest/manifest?format=xml", "")
	if w.Code != http.StatusBadRequest || len(f.calls) != 2 {
		t.Errorf("format=xml: got %d, %d gateway calls", w.Code, len(f.calls))
	}
}

func TestScheduleManifestInvalidYAML(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		io.WriteString(w, "a: [unclosed\n")
	}}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	w := doReq(r, "GET", "/api/schedules/roundtable/morning-digest/manifest?format=json", "")
	if w.Code != http.StatusBadGateway {
		t.Errorf("got %d %s", w.Code, w.Body)
	}
}

func TestScheduleManifestBodyTooLarge(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/yaml")
		io.WriteString(w, strings.Repeat("a", gatewayMaxBody+1))
	}}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
	w := doReq(r, "GET", "/api/schedules/roundtable/morning-digest/manifest", "")
	if w.Code != http.StatusBadGateway || !strings.Contains(w.Body.String(), `"error":"Gateway response too large"`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
}

func TestScheduleTableActionForwardsBody(t *testing.T) {
	f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
		io.WriteString(w, `{"changed":["a"],"unchanged":[],"failed":[]}`)
	}}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	cases := []struct{ action, body, wantBody string }{
		{"suspend", `{"table":"knights"}`, `{"table":"knights"}`},
		{"resume", `{"table":"knights","namespace":"roundtable"}`, `{"namespace":"roundtable","table":"knights"}`},
		{"suspend", `{"table":"knights","namespace":"","bogus":1}`, `{"table":"knights"}`},
	}
	for i, c := range cases {
		w := doReq(r, "POST", "/api/schedules/"+c.action, c.body)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"changed":["a"]`) {
			t.Errorf("%s %s: got %d %s", c.action, c.body, w.Code, w.Body)
			continue
		}
		got := f.calls[i]
		if got.method != "POST" || got.path != "/v1/schedules/"+c.action || got.query != "" || got.auth != "Bearer tok" || got.body != c.wantBody {
			t.Errorf("%s %s: gateway call %+v", c.action, c.body, got)
		}
	}
}

func TestScheduleTableActionValidation(t *testing.T) {
	f := &fakeGateway{}
	srv := f.server(t)
	r := scheduleRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})

	for _, body := range []string{
		``,
		`not json`,
		`[]`,
		`{}`,
		`{"table":null}`,
		`{"table":""}`,
		`{"table":42}`,
		`{"table":"Knights"}`,
		`{"table":"knights","namespace":"Bad_NS"}`,
		`{"table":"knights","namespace":42}`,
	} {
		for _, action := range []string{"suspend", "resume"} {
			w := doReq(r, "POST", "/api/schedules/"+action, body)
			if w.Code != http.StatusBadRequest {
				t.Errorf("%s %q: got %d %s", action, body, w.Code, w.Body)
			}
		}
	}
	if len(f.calls) != 0 {
		t.Errorf("invalid bodies reached the gateway: %+v", f.calls)
	}
}

func TestScheduleTableActionPassesGatewayStatusThrough(t *testing.T) {
	cases := []struct {
		status int
		body   string
	}{
		{http.StatusForbidden, `{"error":"forbidden"}`},
		{http.StatusServiceUnavailable, `{"error":"unavailable"}`},
		{http.StatusOK, `{"changed":[],"unchanged":["b"],"failed":[{"name":"c","error":"boom"}]}`},
	}
	for _, c := range cases {
		f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
			w.WriteHeader(c.status)
			io.WriteString(w, c.body)
		}}
		srv := f.server(t)
		r := scheduleRouter(&gatewayClient{baseURL: srv.URL, token: "tok", http: srv.Client()})
		w := doReq(r, "POST", "/api/schedules/resume", `{"table":"knights"}`)
		if w.Code != c.status || w.Body.String() != c.body {
			t.Errorf("status %d: got %d %s", c.status, w.Code, w.Body)
		}
	}
}

func TestScheduleTableActionGatewayNotConfigured(t *testing.T) {
	r := scheduleRouter(&gatewayClient{http: http.DefaultClient})
	for _, action := range []string{"suspend", "resume"} {
		w := doReq(r, "POST", "/api/schedules/"+action, `{"table":"knights"}`)
		if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "Gateway not configured") {
			t.Errorf("%s: got %d %s", action, w.Code, w.Body)
		}
	}
}
