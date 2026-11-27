package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
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
