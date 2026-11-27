package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

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
	case apierrors.IsInvalid(err), apierrors.IsBadRequest(err):
		var st apierrors.APIStatus
		if errors.As(err, &st) && st.Status().Message != "" {
			return http.StatusUnprocessableEntity, st.Status().Message
		}
		return http.StatusUnprocessableEntity, "Invalid " + lower
	case apierrors.IsTimeout(err), apierrors.IsServerTimeout(err), apierrors.IsServiceUnavailable(err),
		errors.Is(err, context.DeadlineExceeded):
		return http.StatusBadGateway, "Kubernetes API unavailable, try again"
	}
	return http.StatusInternalServerError, "Failed to " + verb + " " + lower
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
