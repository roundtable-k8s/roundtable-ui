package main

import (
	"encoding/json"
	"net/http"

	"github.com/nats-io/nats.go"
)

// k8sHealth maps client availability to the health value.
func k8sHealth(available bool) string {
	if available {
		return "connected"
	}
	return "unavailable"
}

// natsHealth maps the connection status to "connected", "reconnecting" or "disconnected".
func natsHealth(c *nats.Conn) string {
	if c == nil {
		return "disconnected"
	}
	switch c.Status() {
	case nats.CONNECTED:
		return "connected"
	case nats.RECONNECTING, nats.CONNECTING:
		return "reconnecting"
	default:
		return "disconnected"
	}
}

// healthHandler always answers 200 {"status":"ok"} (probes depend on it) and
// reports Kubernetes and NATS connectivity as additive fields (#433).
func healthHandler(k8s, natsFn func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		body := map[string]string{"status": "ok", "kubernetes": "unavailable", "nats": "disconnected"}
		if k8s != nil {
			body["kubernetes"] = k8s()
		}
		if natsFn != nil {
			body["nats"] = natsFn()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(body)
	}
}
