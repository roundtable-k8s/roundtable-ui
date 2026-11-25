package main

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/watch"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

func testChain(name, phase, rv string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "ai.roundtable.io/v1alpha1",
		"kind":       "Chain",
		"metadata":   map[string]interface{}{"name": name, "namespace": "roundtable", "resourceVersion": rv},
		"spec":       map[string]interface{}{},
		"status":     map[string]interface{}{"phase": phase},
	}}
	return u
}

// chainTestClient returns a fake dynamic client seeded with objs whose Watch
// calls are served, in order, from the returned channel of fake watchers.
func chainTestClient(t *testing.T, objs ...runtime.Object) (*dynamicfake.FakeDynamicClient, chan *watch.FakeWatcher) {
	t.Helper()
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{chainGVR: "ChainList", knightGVR: "KnightList"}, objs...)
	watchers := make(chan *watch.FakeWatcher, 4)
	client.PrependWatchReactor("chains", func(k8stesting.Action) (bool, watch.Interface, error) {
		w := watch.NewFake()
		watchers <- w
		return true, w, nil
	})
	return client, watchers
}

type chainEventSink struct {
	mu     sync.Mutex
	events []TaskEvent
	ch     chan struct{}
}

func newChainEventSink() *chainEventSink { return &chainEventSink{ch: make(chan struct{}, 64)} }

func (s *chainEventSink) add(data []byte) {
	var ev TaskEvent
	if err := json.Unmarshal(data, &ev); err != nil {
		panic(err)
	}
	s.mu.Lock()
	s.events = append(s.events, ev)
	s.mu.Unlock()
	s.ch <- struct{}{}
}

func (s *chainEventSink) next(t *testing.T, within time.Duration) (TaskEvent, ChainSummary) {
	t.Helper()
	select {
	case <-s.ch:
	case <-time.After(within):
		t.Fatalf("no chain event within %s", within)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ev := s.events[0]
	s.events = s.events[1:]
	var cs ChainSummary
	if err := json.Unmarshal(ev.Data, &cs); err != nil {
		t.Fatalf("decode ChainSummary: %v", err)
	}
	return ev, cs
}

func (s *chainEventSink) none(t *testing.T, within time.Duration) {
	t.Helper()
	select {
	case <-s.ch:
		s.mu.Lock()
		defer s.mu.Unlock()
		t.Fatalf("unexpected chain event: %+v", s.events)
	case <-time.After(within):
	}
}

func startChainWatcher(t *testing.T, client *dynamicfake.FakeDynamicClient) (*chainWatcher, *chainEventSink) {
	t.Helper()
	return startChainWatcherWith(t, client, nil)
}

func startChainWatcherWith(t *testing.T, client *dynamicfake.FakeDynamicClient, reg *runningRegistry) (*chainWatcher, *chainEventSink) {
	t.Helper()
	cw := newChainWatcher(client, "roundtable", reg)
	cw.backoff = 10 * time.Millisecond
	sink := newChainEventSink()
	unsub := cw.subscribe(sink.add)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { cw.run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); unsub(); <-done })
	return cw, sink
}

func TestChainWatcherStatusChangeEmitsOneEvent(t *testing.T) {
	client, watchers := chainTestClient(t, testChain("nightly", "Running", "1"))
	_, sink := startChainWatcher(t, client)

	// Initial list announces the existing chain.
	ev, cs := sink.next(t, 2*time.Second)
	if ev.Type != "chain" || ev.Op != chainOpUpsert || cs.Name != "nightly" || cs.Phase != "Running" {
		t.Fatalf("initial event = %+v %+v", ev, cs)
	}

	var w *watch.FakeWatcher
	select {
	case w = <-watchers:
	case <-time.After(2 * time.Second):
		t.Fatal("watch never started")
	}

	w.Modify(testChain("nightly", "Succeeded", "2"))
	ev, cs = sink.next(t, 2*time.Second)
	if ev.Type != "chain" || ev.Op != chainOpUpsert || ev.Subject != "chains.nightly" {
		t.Fatalf("event = %+v", ev)
	}
	if cs.Name != "nightly" || cs.Namespace != "roundtable" || cs.Phase != "Succeeded" {
		t.Fatalf("summary = %+v", cs)
	}
	sink.none(t, 100*time.Millisecond)

	w.Delete(testChain("nightly", "Succeeded", "3"))
	ev, cs = sink.next(t, 2*time.Second)
	if ev.Op != chainOpDelete || cs.Name != "nightly" {
		t.Fatalf("delete event = %+v %+v", ev, cs)
	}
}

func TestChainWatcherRelistsOnWatchError(t *testing.T) {
	client, watchers := chainTestClient(t, testChain("a", "Running", "1"), testChain("b", "Running", "1"))
	_, sink := startChainWatcher(t, client)
	sink.next(t, 2*time.Second)
	sink.next(t, 2*time.Second)
	w := <-watchers

	// While the watch is broken, "a" changes and "b" is deleted.
	ctx := context.Background()
	if _, err := client.Resource(chainGVR).Namespace("roundtable").Update(ctx, testChain("a", "Failed", "5"), metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := client.Resource(chainGVR).Namespace("roundtable").Delete(ctx, "b", metav1.DeleteOptions{}); err != nil {
		t.Fatal(err)
	}
	w.Error(&metav1.Status{Status: metav1.StatusFailure, Code: 410, Reason: metav1.StatusReasonExpired})

	got := map[string]string{}
	for i := 0; i < 2; i++ {
		ev, cs := sink.next(t, 2*time.Second)
		got[cs.Name] = ev.Op + ":" + cs.Phase
	}
	if got["a"] != "upsert:Failed" || got["b"] != "delete:" {
		t.Fatalf("re-list diff = %v", got)
	}

	// A new watch is established after the re-list; unchanged chains are not re-sent.
	select {
	case <-watchers:
	case <-time.After(2 * time.Second):
		t.Fatal("watch not re-established")
	}
	sink.none(t, 100*time.Millisecond)
}

func TestChainWatcherResumesWhenStreamCloses(t *testing.T) {
	client, watchers := chainTestClient(t, testChain("a", "Running", "1"))
	_, sink := startChainWatcher(t, client)
	sink.next(t, 2*time.Second)
	w := <-watchers
	w.Stop() // server-side timeout: resume watching, no re-list diff
	w2 := <-watchers
	sink.none(t, 50*time.Millisecond)
	w2.Modify(testChain("a", "Succeeded", "2"))
	if _, cs := sink.next(t, 2*time.Second); cs.Phase != "Succeeded" {
		t.Fatalf("summary = %+v", cs)
	}
}

func TestChainWatcherJoinsInFlightOnEveryUpdate(t *testing.T) {
	obj := &unstructured.Unstructured{Object: loadChainFixture(t, "fanout.json")}
	obj.SetResourceVersion("1")
	client, watchers := chainTestClient(t, obj)
	reg, _ := newTestRegistry(100)
	reg.handleActivity(activity(t, "task.started", "fanout-scan-1795548808-scan-8", 1,
		map[string]any{"ts": "2026-11-24T11:58:00Z", "pod": "galahad-abc-1"}), "Galahad")
	_, sink := startChainWatcherWith(t, client, reg)

	check := func(label string, cs ChainSummary) {
		t.Helper()
		var step *StepSummary
		for i := range cs.Steps {
			if cs.Steps[i].Name == "scan" {
				step = &cs.Steps[i]
			}
		}
		if step == nil || step.FanOut == nil {
			t.Fatalf("%s: scan step/fanOut missing", label)
		}
		for _, it := range step.FanOut.Items {
			if it.Index == 8 {
				if it.InFlight == nil || it.InFlight.Pod != "galahad-abc-1" {
					t.Fatalf("%s: item 8 inFlight = %+v, want pod galahad-abc-1", label, it.InFlight)
				}
				return
			}
		}
		t.Fatalf("%s: item 8 missing", label)
	}

	_, cs := sink.next(t, 2*time.Second)
	check("initial list", cs)

	w := <-watchers
	mod := obj.DeepCopy()
	mod.SetResourceVersion("2")
	_ = unstructured.SetNestedField(mod.Object, "Running", "status", "phase")
	mod.SetAnnotations(map[string]string{"touched": "1"})
	w.Modify(mod)
	_, cs = sink.next(t, 2*time.Second)
	check("watch update", cs)
}

func TestCachedDomainsNegativeCache(t *testing.T) {
	calls := 0
	get := cachedDomains(time.Hour, func(ctx context.Context) map[string]knightInfo {
		calls++
		return nil
	})
	for i := 0; i < 3; i++ {
		get(context.Background())
	}
	if calls != 1 {
		t.Fatalf("failing fn called %d times within ttl, want 1", calls)
	}
}
