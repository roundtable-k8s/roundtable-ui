package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// TestHandlersAnswer502WhenKubernetesStalls runs every handler that makes a
// single-object Kubernetes call (#624) against an API server that never
// answers. Only the handler's own deadline can end the call, so each must
// reply 502 within the shortened k8sRequestTimeout.
//
// Allowed exceptions to "no r.Context() on a Kubernetes call": the list
// handlers that read through cachedList (informer-backed; its direct fallback
// is bounded in listcache.go), the watch loops (chain_watch.go) and the
// background samplers, which carry their own timeouts.
func TestHandlersAnswer502WhenKubernetesStalls(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	cfg := &rest.Config{Host: srv.URL}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	dc, err := dynamic.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	oldK, oldD, oldT, oldQ := k8sClient, dynClient, k8sRequestTimeout, queues
	k8sClient, dynClient, k8sRequestTimeout, queues = cs, dc, 150*time.Millisecond, newFakeJetStream()
	t.Cleanup(func() { k8sClient, dynClient, k8sRequestTimeout, queues = oldK, oldD, oldT, oldQ })

	const ns = "roundtable"
	r := mux.NewRouter()
	r.HandleFunc("/chains/{name}", chainDetailHandler(ns, nil)).Methods("GET")
	r.HandleFunc("/missions/{name}", missionDetailHandler(ns)).Methods("GET")
	r.HandleFunc("/missions", missionCreateHandler(ns)).Methods("POST")
	r.HandleFunc("/missions/{name}", missionDeleteHandler(ns)).Methods("DELETE")
	r.HandleFunc("/roundtables/{name}", roundTableDetailHandler(ns)).Methods("GET")
	r.HandleFunc("/triggers/{namespace}/{name}", triggerDetailHandler(ns)).Methods("GET")
	r.HandleFunc("/fleet/{knight}/queue", knightQueueHandler(ns)).Methods("GET")
	r.HandleFunc("/fleet/{knight}/session", knightSessionHandler("fleet-a")).Methods("GET")
	r.HandleFunc("/fleet/{knight}/pods", knightPodsHandler(ns, nil)).Methods("GET")
	r.HandleFunc("/fleet/{knight}/logs", knightLogsHandler(ns)).Methods("GET")

	cases := []struct{ method, path, body string }{
		{"GET", "/chains/c1", ""},
		{"GET", "/missions/m1", ""},
		{"POST", "/missions", `{"name":"m1","objective":"do it"}`},
		{"DELETE", "/missions/m1", ""},
		{"GET", "/roundtables/rt1", ""},
		{"GET", "/triggers/" + ns + "/t1", ""},
		{"GET", "/fleet/k1/queue", ""},
		{"GET", "/fleet/k1/session", ""},
		{"GET", "/fleet/k1/pods", ""},
		{"GET", "/fleet/k1/logs", ""},
	}
	for _, c := range cases {
		t.Run(c.method+" "+c.path, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
			rec := httptest.NewRecorder()
			start := time.Now()
			r.ServeHTTP(rec, req)
			if d := time.Since(start); d > 3*time.Second {
				t.Fatalf("took %v, deadline not honoured", d)
			}
			if rec.Code != http.StatusBadGateway {
				t.Fatalf("status = %d, want 502; body %s", rec.Code, rec.Body)
			}
			if !strings.Contains(rec.Body.String(), "Kubernetes API unavailable, try again") {
				t.Fatalf("body = %s", rec.Body)
			}
		})
	}
}

// getKnightCR and knightPodsForIntrospect have no request; they bound
// themselves.
func TestKnightHelpersHonourDeadline(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	cfg := &rest.Config{Host: srv.URL}
	cs, _ := kubernetes.NewForConfig(cfg)
	dc, _ := dynamic.NewForConfig(cfg)
	oldK, oldD, oldT := k8sClient, dynClient, k8sRequestTimeout
	k8sClient, dynClient, k8sRequestTimeout = cs, dc, 100*time.Millisecond
	t.Cleanup(func() { k8sClient, dynClient, k8sRequestTimeout = oldK, oldD, oldT })

	start := time.Now()
	if _, err := getKnightCR(t.Context(), "k1"); err == nil {
		t.Fatal("getKnightCR: expected error")
	}
	if _, err := knightPodsForIntrospect(t.Context(), "ns", "k1"); err == nil {
		t.Fatal("knightPodsForIntrospect: expected error")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v", d)
	}
}
