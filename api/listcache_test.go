package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestTriggersServedFromWatchCache(t *testing.T) {
	r := setupTriggerRouter(t,
		trigObj("a", map[string]interface{}{"nats": map[string]interface{}{"subject": "x"}}, nil))
	fc := dynClient.(*fake.FakeDynamicClient)
	var lists atomic.Int32
	fc.PrependReactor("list", "triggers", func(k8stesting.Action) (bool, runtime.Object, error) {
		lists.Add(1)
		return false, nil, nil
	})

	for i := 0; i < 3; i++ {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/triggers", nil))
		if w.Code != http.StatusOK {
			t.Fatalf("status %d", w.Code)
		}
	}
	if n := lists.Load(); n != 1 {
		t.Fatalf("expected 1 list call for 3 requests, got %d", n)
	}

	// An object created after start-up shows up via the watch.
	b := &unstructured.Unstructured{Object: trigObj("b", map[string]interface{}{"nats": map[string]interface{}{"subject": "y"}}, nil)}
	if _, err := dynClient.Resource(triggerGVR).Namespace("roundtable").Create(context.Background(), b, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		items, err := cachedList(context.Background(), dynClient, triggerGVR, "roundtable")
		if err != nil {
			t.Fatal(err)
		}
		if len(items) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("new trigger not seen, have %d", len(items))
		}
		time.Sleep(20 * time.Millisecond)
	}
	if n := lists.Load(); n != 1 {
		t.Fatalf("watch update caused extra list calls: %d", n)
	}
}

func TestCachedListFailedSyncRemembered(t *testing.T) {
	t.Cleanup(resetListCache)
	fc := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{triggerGVR: "TriggerList"})
	fc.PrependWatchReactor("*", func(k8stesting.Action) (bool, watch.Interface, error) {
		return true, nil, errors.New("watch forbidden")
	})
	// The informer's initial list also fails, so it can never sync.
	var informerLists atomic.Int32
	fc.PrependReactor("list", "triggers", func(k8stesting.Action) (bool, runtime.Object, error) {
		informerLists.Add(1)
		return true, nil, errors.New("list unavailable")
	})
	oldTimeout := listCacheSyncTimeout
	listCacheSyncTimeout = 50 * time.Millisecond
	t.Cleanup(func() { listCacheSyncTimeout = oldTimeout })

	// The first read waits for the sync timeout, then remembers the failure.
	_, _ = cachedList(context.Background(), fc, triggerGVR, "roundtable")
	listCacheMu.Lock()
	remembered := false
	for _, e := range listCacheInformers {
		remembered = remembered || !e.failedAt.IsZero()
	}
	listCacheMu.Unlock()
	if !remembered {
		t.Fatal("failed sync not remembered")
	}

	// The second read must skip the wait: with an hour-long sync timeout it
	// would hang if it waited.
	listCacheSyncTimeout = time.Hour
	done := make(chan struct{})
	go func() {
		_, _ = cachedList(context.Background(), fc, triggerGVR, "roundtable")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("second read should skip the wait")
	}
}

func TestResetListCacheStopsInformers(t *testing.T) {
	fc := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{triggerGVR: "TriggerList"})
	if _, err := cachedList(context.Background(), fc, triggerGVR, "roundtable"); err != nil {
		t.Fatal(err)
	}
	resetListCache()
	listCacheMu.Lock()
	n := len(listCacheInformers)
	listCacheMu.Unlock()
	if n != 0 {
		t.Fatalf("registry not cleared: %d", n)
	}
}

func TestSharedTableCacheOneLookup(t *testing.T) {
	var lookups atomic.Int32
	tc := newTableCache(func(context.Context) map[string]string {
		lookups.Add(1)
		return map[string]string{"galahad": "t"}
	}, time.Hour, time.Second)
	tc.refresh()
	// Two "connections" read the same cache.
	a, b := tc.get(), tc.get()
	if a["galahad"] != "t" || b["galahad"] != "t" || lookups.Load() != 1 {
		t.Fatalf("lookups=%d", lookups.Load())
	}
}
