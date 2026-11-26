package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

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
// message a client should see. The raw error is logged, never returned, except
// for 422 where the Kubernetes status message names the offending field.
func k8sErrorStatus(ctx context.Context, err error, what string) (int, string) {
	slog.ErrorContext(ctx, what+" error", "error", err)
	switch {
	case apierrors.IsAlreadyExists(err):
		return http.StatusConflict, "A mission with this name already exists"
	case apierrors.IsNotFound(err):
		return http.StatusNotFound, "Mission not found"
	case apierrors.IsForbidden(err):
		return http.StatusForbidden, "Not allowed to " + what + " this mission"
	case apierrors.IsInvalid(err), apierrors.IsBadRequest(err):
		var st apierrors.APIStatus
		if errors.As(err, &st) && st.Status().Message != "" {
			return http.StatusUnprocessableEntity, st.Status().Message
		}
		return http.StatusUnprocessableEntity, "Invalid mission"
	case apierrors.IsTimeout(err), apierrors.IsServerTimeout(err), apierrors.IsServiceUnavailable(err):
		return http.StatusServiceUnavailable, "Kubernetes API unavailable, try again"
	}
	return http.StatusInternalServerError, "Failed to " + what + " mission"
}
