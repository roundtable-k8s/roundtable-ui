package main

import (
	"net/http"
	"regexp"
	"strings"
)

// Defence-in-depth redaction (#188). Knights redact secrets before publishing;
// the API runs a second pass over everything it relays to a browser (logs,
// session transcripts, results, KV values, WebSocket events). Replacements
// never contain quotes or backslashes, so redacting serialized JSON keeps it
// valid.

const redactedMarker = "[REDACTED]"

// maxLiveEventBytes is the largest activity event relayed over the WebSocket.
// Larger droppable (task stream) events are dropped rather than truncated,
// since a truncated JSON document would be unparseable.
const maxLiveEventBytes = 256 * 1024

type redactRule struct {
	re   *regexp.Regexp
	repl string
}

var redactRules = []redactRule{
	// PEM blocks, including JSON-escaped (\n) bodies and blocks cut off before END.
	{regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s\\]*(?:-----END [A-Z ]*PRIVATE KEY-----)?`), redactedMarker},
	// Authorization headers (keeps the header name).
	{regexp.MustCompile(`(?i)(\bauthorization\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s"'\\]+`), "${1}" + redactedMarker},
	{regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`), "${1} " + redactedMarker},
	// Well-known token formats.
	{regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})`), redactedMarker},
	{regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}`), redactedMarker},
	{regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`), redactedMarker},
	{regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`), redactedMarker},
	{regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), redactedMarker},
	// key=value / "key": "value" for secret-looking keys.
	{regexp.MustCompile(`(?i)\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key)\b["']?\s*[:=]\s*["']?)[^\s"',\;&]{4,}`), "${1}" + redactedMarker},
}

// redactSecrets masks secret-looking substrings in s.
func redactSecrets(s string) string {
	for _, r := range redactRules {
		s = r.re.ReplaceAllString(s, r.repl)
	}
	return s
}

func redactBytes(b []byte) []byte { return []byte(redactSecrets(string(b))) }

// redactedJSON writes a redacted JSON body.
func writeRedactedJSON(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(redactBytes(body))
}

// securityHeaders sets headers appropriate for every response.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/metrics" {
			w.Header().Set("Content-Security-Policy", spaCSP)
			w.Header().Set("X-Frame-Options", "DENY")
		}
		next.ServeHTTP(w, r)
	})
}

// spaCSP: no inline script, same-origin only; connect-src covers fetch and
// same-origin WebSocket (ws:/wss: scheme sources, as 'self' does not cover
// WebSocket in every browser). Inline styles are allowed because React/xyflow
// set style attributes.
const spaCSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws: wss:; " +
	"object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
