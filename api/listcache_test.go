package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
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
