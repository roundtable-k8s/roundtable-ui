package main

import (
	"encoding/json"
	"net/http"
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
