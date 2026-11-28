package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
)

// jsonError writes an error response with a JSON body of the form
// {"error": "<msg>"} and the given status code. Every API error goes through
// it so clients can parse one shape. It mirrors http.Error's nosniff header.
func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// k8sErrorStatus maps a Kubernetes API error to the HTTP status and the short
// message a client should see. verb is "read", "create" or "delete"; noun is
// the resource ("mission", "trigger", "RoundTable"). The raw error is never
// returned, except for 422 where the Kubernetes status message names the
// offending field.
//
// Per verb: AlreadyExists is 409 and NotFound 404 for every verb. Forbidden is
// 403 for writes (create, delete) but 500 for reads, because a forbidden read
// is the dashboard's own RBAC gap. Invalid/BadRequest is 422 only for writes;
// a read answers the generic 500 "Failed to read X". Timeouts and an
// unavailable API are 502 for every verb.
func k8sErrorStatus(err error, verb, noun string) (int, string) {
	lower := strings.ToLower(noun)
	switch {
	case apierrors.IsAlreadyExists(err):
		return http.StatusConflict, "A " + lower + " with this name already exists"
	case apierrors.IsNotFound(err):
		return http.StatusNotFound, upperFirst(noun) + " not found"
	case apierrors.IsForbidden(err) && verb != "read":
		// A forbidden read is the dashboard's own RBAC gap, not the caller's.
		return http.StatusForbidden, "Not allowed to " + verb + " this " + lower
	case (apierrors.IsInvalid(err) || apierrors.IsBadRequest(err)) && verb != "read":
		var st apierrors.APIStatus
		if errors.As(err, &st) && st.Status().Message != "" {
			return http.StatusUnprocessableEntity, st.Status().Message
		}
		return http.StatusUnprocessableEntity, "Invalid " + lower
	case apierrors.IsTimeout(err), apierrors.IsServerTimeout(err), apierrors.IsServiceUnavailable(err),
		errors.Is(err, context.DeadlineExceeded), isNetworkError(err):
		return http.StatusBadGateway, "Kubernetes API unavailable, try again"
	}
	return http.StatusInternalServerError, "Failed to " + verb + " " + lower
}

// isNetworkError reports a transport failure (connection refused, name not
// resolved, reset): client-go returns it as a *url.Error wrapping a
// *net.OpError, never as an API status.
func isNetworkError(err error) bool {
	var ne net.Error
	var op *net.OpError
	var dns *net.DNSError
	return errors.As(err, &ne) || errors.As(err, &op) || errors.As(err, &dns)
}

func upperFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// logK8sError logs a failed Kubernetes call: a client disconnect at DEBUG, a
// missing object not at all, everything else at ERROR.
func logK8sError(ctx context.Context, err error, verb, noun string) {
	switch {
	case errors.Is(err, context.Canceled):
		slog.DebugContext(ctx, "Kubernetes request cancelled by client", "verb", verb, "resource", noun)
	case apierrors.IsNotFound(err):
	default:
		slog.ErrorContext(ctx, verb+" "+strings.ToLower(noun)+" failed", "error", err)
	}
}

// writeK8sError answers a failed Kubernetes call with the one shared mapping
// (see k8sErrorStatus) and logs it (see logK8sError).
func writeK8sError(w http.ResponseWriter, r *http.Request, err error, verb, noun string) {
	logK8sError(r.Context(), err, verb, noun)
	code, msg := k8sErrorStatus(err, verb, noun)
	jsonError(w, msg, code)
}

// upstreamError answers a failed Kubernetes or NATS read with the one shared
// mapping, so the same failure has the same status on every route: an
// unreachable or slow Kubernetes API, a NATS timeout or a deadline is 502
// "unavailable, try again"; anything else is 500 "Failed to read <noun>". A
// cancelled request context writes nothing (the client is gone). 504 is kept
// for introspect, where the knight is the slow party.
func upstreamError(w http.ResponseWriter, r *http.Request, err error, noun string) {
	if errors.Is(err, context.Canceled) {
		slog.DebugContext(r.Context(), "request cancelled by client", "resource", noun)
		return
	}
	slog.ErrorContext(r.Context(), "read "+noun+" failed", "error", err)
	if errors.Is(err, nats.ErrTimeout) || errors.Is(err, nats.ErrNoResponders) ||
		errors.Is(err, nats.ErrConnectionClosed) {
		jsonError(w, "NATS unavailable, try again", http.StatusBadGateway)
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		// A bare deadline could be Kubernetes or NATS: do not blame either.
		jsonError(w, "Upstream timed out, try again", http.StatusBadGateway)
		return
	}
	code, msg := k8sErrorStatus(err, "read", noun)
	jsonError(w, msg, code)
}

// Messages for a failed gateway call.
const (
	gatewayCredentialsMsg = "Gateway rejected the dashboard's credentials (check GATEWAY_TOKEN or the ServiceAccount)"
	gatewayTimeoutMsg     = "Gateway timed out"
	gatewayUnreachableMsg = "Gateway unreachable"
)

// gatewayWarnEvery limits the gateway-credential WARN log to one per interval.
const gatewayWarnEvery = time.Minute

var (
	gatewayWarnMu   sync.Mutex
	gatewayWarnLast time.Time
)

func warnGatewayCredentials(r *http.Request, path string, status int) {
	gatewayWarnMu.Lock()
	due := time.Since(gatewayWarnLast) >= gatewayWarnEvery
	if due {
		gatewayWarnLast = time.Now()
	}
	gatewayWarnMu.Unlock()
	if due {
		slog.WarnContext(r.Context(), "gateway rejected the dashboard's credentials", "path", path, "status", status)
	}
}

// isGatewayAuthRejection reports whether a gateway answer is the auth
// middleware refusing the dashboard's own token: any 401, or a 403 whose body
// starts with "forbidden:" (the snapshot-disabled 403 does not).
func isGatewayAuthRejection(status int, body []byte) bool {
	if status == http.StatusUnauthorized {
		return true
	}
	if status != http.StatusForbidden {
		return false
	}
	var b struct {
		Error string `json:"error"`
	}
	msg := strings.TrimSpace(string(body))
	if json.Unmarshal(body, &b) == nil && b.Error != "" {
		msg = b.Error
	}
	return isGatewayAuthMessage(status, msg)
}

// isGatewayAuthMessage is isGatewayAuthRejection for an already extracted
// error message.
func isGatewayAuthMessage(status int, msg string) bool {
	return status == http.StatusUnauthorized ||
		(status == http.StatusForbidden && strings.HasPrefix(msg, "forbidden:"))
}

// relayGatewayAnswer writes a gateway HTTP answer to the browser: the
// dashboard's own rejected credentials become 502, Retry-After of a 429/503 is
// copied, everything else is relayed as is. Shared by every gateway route.
func relayGatewayAnswer(w http.ResponseWriter, r *http.Request, path string, status int, b []byte, hdr http.Header) {
	if isGatewayAuthRejection(status, b) {
		warnGatewayCredentials(r, path, status)
		jsonError(w, gatewayCredentialsMsg, http.StatusBadGateway)
		return
	}
	if v := hdr.Get("Idempotent-Replay"); v != "" {
		w.Header().Set("Idempotent-Replay", v)
	}
	if status == http.StatusTooManyRequests || status == http.StatusServiceUnavailable {
		if v := hdr.Get("Retry-After"); v != "" && validHeaderToken(v) {
			w.Header().Set("Retry-After", v)
		}
	}
	writeGatewayResponse(w, status, b)
}

// fail answers a failed gateway call (no HTTP answer): a too-large body is
// 502; a timeout is 504; a cancelled request writes nothing; anything else
// (refused, reset) is 502.
func (g *gatewayClient) fail(w http.ResponseWriter, r *http.Request, path string, err error) {
	var ne net.Error
	switch {
	case errors.Is(err, errGatewayBodyTooLarge):
		slog.WarnContext(r.Context(), "gateway response over relay limit", "path", path, "limit_bytes", gatewayMaxBody)
		jsonError(w, "Gateway response too large", http.StatusBadGateway)
	case errors.Is(err, context.Canceled) || r.Context().Err() == context.Canceled:
		slog.DebugContext(r.Context(), "gateway request cancelled by client", "path", path)
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()):
		slog.ErrorContext(r.Context(), "gateway request timed out", "path", path, "error", err)
		jsonError(w, gatewayTimeoutMsg, http.StatusGatewayTimeout)
	default:
		slog.ErrorContext(r.Context(), "gateway request failed", "path", path, "error", err)
		jsonError(w, gatewayUnreachableMsg, http.StatusBadGateway)
	}
}
