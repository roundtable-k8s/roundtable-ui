package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nats-io/nats.go"
)

func TestHealthReportsConnectivity(t *testing.T) {
	cases := []struct{ name, k8s, nats string }{
		{"all up", "connected", "connected"},
		{"k8s down", "unavailable", "connected"},
		{"nats reconnecting", "connected", "reconnecting"},
		{"nats down", "unavailable", "disconnected"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := buildRouter(routerDeps{
				k8sStatus:  func() string { return c.k8s },
				natsStatus: func() string { return c.nats },
			})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "/api/health", nil))
			if w.Code != http.StatusOK {
				t.Fatalf("code %d, want 200", w.Code)
			}
			var got map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if got["status"] != "ok" || got["kubernetes"] != c.k8s || got["nats"] != c.nats {
				t.Fatalf("body %v", got)
			}
		})
	}
}

func TestHealthWithoutChecksReportsWorstState(t *testing.T) {
	w := httptest.NewRecorder()
	buildRouter(routerDeps{}).ServeHTTP(w, httptest.NewRequest("GET", "/api/health", nil))
	var got map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if w.Code != 200 || got["status"] != "ok" || got["kubernetes"] != "unavailable" || got["nats"] != "disconnected" {
		t.Fatalf("%d %v", w.Code, got)
	}
}

func TestK8sHealthNilClients(t *testing.T) {
	if k8sHealth(dynClient != nil && k8sClient != nil) != "unavailable" && dynClient == nil {
		t.Fatal("nil dynClient must be unavailable")
	}
	if k8sHealth(true) != "connected" || k8sHealth(false) != "unavailable" {
		t.Fatal("mapping")
	}
}

func TestNatsHealth(t *testing.T) {
	if natsHealth(nil) != "disconnected" {
		t.Fatal("nil conn")
	}
	if natsHealth(&nats.Conn{}) != "disconnected" && natsHealth(&nats.Conn{}) != "connected" {
		t.Fatal("unexpected")
	}
}
