package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"
)

func TestKnightPodsByNameHonoursDeadline(t *testing.T) {
	// A real client against a server that never answers: only the context
	// deadline can end the call.
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	cs, err := kubernetes.NewForConfig(&rest.Config{Host: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	old, oldT := k8sClient, k8sRequestTimeout
	k8sClient, k8sRequestTimeout = cs, 100*time.Millisecond
	t.Cleanup(func() { k8sClient, k8sRequestTimeout = old, oldT })

	ctx, cancel := k8sCtx(httptest.NewRequest("GET", "/", nil))
	defer cancel()
	start := time.Now()
	if got := knightPodsByName(ctx, "ns"); len(got) != 0 {
		t.Fatalf("expected empty map, got %v", got)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v, deadline not honoured", d)
	}

	start = time.Now()
	if _, _, err := listKnightPods(context.Background(), "ns", nil, ""); err == nil {
		t.Fatal("expected deadline error")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("listKnightPods took %v", d)
	}
}

func TestScaleEventsListUsesFieldSelectorAndLimit(t *testing.T) {
	fc := k8sfake.NewSimpleClientset()
	var selectors []string
	fc.PrependReactor("list", "events", func(a k8stesting.Action) (bool, runtime.Object, error) {
		la := a.(k8stesting.ListAction)
		selectors = append(selectors, la.GetListRestrictions().Fields.String())
		return true, &corev1.EventList{Items: []corev1.Event{{Reason: la.GetListRestrictions().Fields.String()}}}, nil
	})
	old := k8sClient
	k8sClient = fc
	t.Cleanup(func() { k8sClient = old })
	s := newClusterQueueSampler("ns")
	if s.listEvents == nil {
		t.Fatal("listEvents not set")
	}
	items, err := s.listEvents(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2 (one per kind)", len(items))
	}
	want := []string{"involvedObject.kind=HorizontalPodAutoscaler", "involvedObject.kind=ScaledObject"}
	if len(selectors) != 2 || selectors[0] != want[0] || selectors[1] != want[1] {
		t.Fatalf("selectors = %v, want %v", selectors, want)
	}
}

func TestApplyKubeClientLimits(t *testing.T) {
	cfg := &rest.Config{}
	applyKubeClientLimits(cfg)
	// A client timeout would cut every watch stream; it must stay unset.
	if cfg.Timeout != 0 || cfg.QPS != 20 || cfg.Burst != 40 {
		t.Fatalf("defaults: %v %v %v", cfg.Timeout, cfg.QPS, cfg.Burst)
	}
	cfg.Timeout = 20 * time.Second
	t.Setenv("KUBE_QPS", "7.5")
	t.Setenv("KUBE_BURST", "bogus")
	applyKubeClientLimits(cfg)
	if cfg.Timeout != 0 || cfg.QPS != 7.5 || cfg.Burst != 40 {
		t.Fatalf("override: %v %v", cfg.QPS, cfg.Burst)
	}
}

// TestKubeClientsHaveNoHTTPTimeout checks the clients the API really builds
// from the config: client-go turns rest.Config.Timeout into the HTTP client
// timeout, so a non-zero value would cut watch streams after that long.
func TestKubeClientsHaveNoHTTPTimeout(t *testing.T) {
	const watchLine = `{"type":"ADDED","object":{"kind":"Pod","apiVersion":"v1","metadata":{"name":"p"}}}` + "\n"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		// Hold the stream open for longer than the configured timeout
		// below would allow, then send one event.
		select {
		case <-time.After(200 * time.Millisecond):
		case <-r.Context().Done():
			return
		}
		_, _ = w.Write([]byte(watchLine))
		w.(http.Flusher).Flush()
		select {
		case <-time.After(200 * time.Millisecond):
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()

	cfg := &rest.Config{Host: srv.URL, Timeout: 50 * time.Millisecond}
	applyKubeClientLimits(cfg)

	hc, err := rest.HTTPClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if hc.Timeout != 0 {
		t.Fatalf("HTTP client timeout = %v, want 0", hc.Timeout)
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := dynamic.NewForConfig(cfg); err != nil {
		t.Fatal(err)
	}

	// A watch must survive past the 50 ms that a client timeout would allow.
	w, err := cs.CoreV1().Pods("ns").Watch(context.Background(), metav1.ListOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Stop()
	select {
	case ev, ok := <-w.ResultChan():
		if !ok {
			t.Fatal("watch closed before the event")
		}
		if ev.Type != watch.Added {
			t.Fatalf("event type = %v, want %v", ev.Type, watch.Added)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no watch event; stream was cut")
	}
}
