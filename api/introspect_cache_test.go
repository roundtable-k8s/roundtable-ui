package main

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	dynfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

// Two concurrent type=stats requests for one knight cost one CR read from the
// cache (no direct GET), one Pod LIST and one NATS fan-out (#633).
func TestIntrospectStatsSharedAcrossConcurrentRequests(t *testing.T) {
	var natsCalls atomic.Int32
	gate := make(chan struct{})
	f := &fakeIntrospect{answer: func(s string) ([]byte, error) {
		natsCalls.Add(1)
		<-gate
		return statsReply("galahad-a", 2, 0.5, 100, 1, "opus"), nil
	}}
	h := setupIntrospectTest(t, f, makeKnightPod("galahad-a", "galahad", true))

	var podLists, crGets atomic.Int32
	fakeK8sClient.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		podLists.Add(1)
		return false, nil, nil
	})
	dynClient.(*dynfake.FakeDynamicClient).PrependReactor("get", "knights", func(k8stesting.Action) (bool, runtime.Object, error) {
		crGets.Add(1)
		return false, nil, nil
	})

	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := range codes {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w, _ := doSession(t, h, "type=stats")
			codes[i] = w.Code
		}()
	}
	time.Sleep(300 * time.Millisecond)
	close(gate)
	wg.Wait()

	for i, c := range codes {
		if c != 200 {
			t.Fatalf("request %d: code %d", i, c)
		}
	}
	if n := natsCalls.Load(); n != 1 {
		t.Errorf("NATS requests = %d, want 1", n)
	}
	if n := podLists.Load(); n != 1 {
		t.Errorf("pod LISTs = %d, want 1", n)
	}
	if n := crGets.Load(); n != 0 {
		t.Errorf("direct Knight GETs = %d, want 0", n)
	}

	// Within the TTL a later request is served from the cache.
	if w, _ := doSession(t, h, "type=stats"); w.Code != 200 {
		t.Fatalf("cached: %d", w.Code)
	}
	if n := natsCalls.Load(); n != 1 {
		t.Errorf("NATS requests after cached read = %d, want 1", n)
	}
	// Other types are never cached.
	before := natsCalls.Load()
	for range 2 {
		doSession(t, h, "type=recent")
	}
	if natsCalls.Load() != before+2 {
		t.Errorf("type=recent was cached")
	}
}

func TestGetKnightCRMissingIs404(t *testing.T) {
	setupTestRouter()
	t.Setenv("NAMESPACE", "test-namespace")
	_, err := getKnightCR(t.Context(), "nope")
	if err == nil || !apierrors.IsNotFound(err) {
		t.Fatalf("err = %v, want not found", err)
	}
}
