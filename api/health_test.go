package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nats-io/nats.go"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
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
	dyn := fake.NewSimpleDynamicClient(runtime.NewScheme())
	kube := k8sfake.NewSimpleClientset()
	if k8sAvailable(nil, nil) || k8sAvailable(nil, kube) {
		t.Fatal("nil dynamic client must be unavailable")
	}
	if k8sAvailable(dyn, nil) {
		t.Fatal("nil kubernetes client must be unavailable")
	}
	if !k8sAvailable(dyn, kube) {
		t.Fatal("both clients set must be available")
	}
	if k8sHealth(true) != "connected" || k8sHealth(false) != "unavailable" {
		t.Fatal("mapping")
	}
}

func TestNatsHealth(t *testing.T) {
	if natsHealth(nil) != "disconnected" {
		t.Fatal("nil conn")
	}
	if got := natsHealth(&nats.Conn{}); got != "disconnected" {
		t.Fatalf("zero conn = %q, want disconnected", got)
	}
}
