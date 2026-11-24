package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestRedactSecrets(t *testing.T) {
	pem := "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc123+/=\nxyz\n-----END RSA PRIVATE KEY-----"
	cases := map[string]string{
		"github token": "ghp_" + strings.Repeat("a1B2", 8),
		"openai key":   "sk-" + strings.Repeat("Ab3", 12),
		"aws key":      "AKIAABCDEFGHIJKLMNOP",
		"slack":        "xoxb-1234567890-abcdefghij",
		"jwt":          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk123",
		"bearer":       "Bearer abcdefghijklmnop12345",
		"auth header":  "Authorization: Basic dXNlcjpwYXNzd29yZA==",
		"kv password":  "password=hunter2hunter2",
		"json secret":  `{"api_key": "supersecretvalue"}`,
		"pem":          pem,
	}
	for name, in := range cases {
		out := redactSecrets("before " + in + " after")
		if !strings.Contains(out, redactedMarker) {
			t.Errorf("%s: not redacted: %q", name, out)
		}
		for _, leak := range []string{"hunter2", "supersecretvalue", "MIIEow", "dXNlcjpwYXNz", "abcdefghijklmnop12345", "ghp_a1B2", "AKIAABCDEFGHIJKLMNOP"} {
			if strings.Contains(out, leak) {
				t.Errorf("%s: leaked %q in %q", name, leak, out)
			}
		}
	}
}

func TestRedactKeepsJSONValidAndPlainText(t *testing.T) {
	ev := map[string]string{"preview": "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "h": "Authorization: Bearer abcdefghijkl", "ok": "hello"}
	b, _ := json.Marshal(ev)
	out := redactBytes(b)
	var back map[string]string
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("redacted JSON invalid: %v: %s", err, out)
	}
	if back["ok"] != "hello" || strings.Contains(string(out), "MIIabc") {
		t.Errorf("unexpected: %s", out)
	}
	for _, benign := range []string{`{"tokens":{"input":12345,"output":67890}}`, "max_tokens=4096", "normal log line"} {
		if got := redactSecrets(benign); got != benign {
			t.Errorf("benign text changed: %q -> %q", benign, got)
		}
	}
}

func TestWSEnqueueRedactsAndDropsOversize(t *testing.T) {
	w := newWSWriter(&fakeConnForRedact{}, 4, func() {})
	big := make([]byte, maxLiveEventBytes+1)
	if w.enqueue(big, false) {
		t.Error("oversize event should be dropped")
	}
	w.enqueue([]byte(`{"d":"token=abcdefghijkl"}`), true)
	w.qmu.Lock()
	defer w.qmu.Unlock()
	if len(w.queue) != 1 || strings.Contains(string(w.queue[0].data), "abcdefghijkl") {
		t.Errorf("queue not redacted: %v", w.queue)
	}
}

type fakeConnForRedact struct{}

func (fakeConnForRedact) SetWriteDeadline(t time.Time) error { return nil }
func (fakeConnForRedact) WriteMessage(int, []byte) error     { return nil }

func TestSecurityHeaders(t *testing.T) {
	h := securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	for path, wantCSP := range map[string]bool{"/": true, "/fleet": true, "/api/fleet": false, "/metrics": false} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: missing nosniff", path)
		}
		csp := rec.Header().Get("Content-Security-Policy")
		if wantCSP != (csp != "") {
			t.Errorf("%s: CSP=%q want present=%v", path, csp, wantCSP)
		}
		if wantCSP && (!strings.Contains(csp, "default-src 'self'") || strings.Contains(csp, "script-src 'self' 'unsafe")) {
			t.Errorf("weak CSP: %s", csp)
		}
	}
}

// Read-only guarantee: the only mutating routes are the documented ones.
func TestNoUnexpectedMutatingRoutes(t *testing.T) {
	allowed := map[string]bool{"POST /api/auth/login": true, "POST /api/tasks/dispatch": true, "POST /api/missions": true, "DELETE /api/missions/{name}": true}
	src, _ := os.ReadFile("main.go")
	for _, line := range strings.Split(string(src), "\n") {
		for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
			if strings.Contains(line, `.Methods("`+m+`")`) && strings.Contains(line, "api.HandleFunc(") {
				path := line[strings.Index(line, `"`)+1:]
				path = path[:strings.Index(path, `"`)]
				if !allowed[m+" /api"+path] {
					t.Errorf("unexpected mutating route %s /api%s", m, path)
				}
			}
		}
	}
}
