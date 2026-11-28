package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/mux"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

type snapshotCounters struct {
	podLists, metricLists, tableLists, probes atomic.Int32
	failPods                                  atomic.Bool
}

// snapshotFixture wires fake clients that count the Kubernetes calls the
// fleet view makes, and a controllable clock for the cache TTLs.
func snapshotFixture(t *testing.T) (*snapshotCounters, *time.Time) {
	t.Helper()
	const ns = "snapns"
	c := &snapshotCounters{}
	dyn := fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			knightGVR:     "KnightList",
			podMetricsGVR: "PodMetricsList",
			roundTableGVR: "RoundTableList",
		})
	if _, err := dyn.Resource(knightGVR).Namespace(ns).Create(context.Background(),
		makeTestKnightCR("lamorak", ns, "coding"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	dyn.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		c.metricLists.Add(1)
		return false, nil, nil
	})
	dyn.PrependReactor("list", "roundtables", func(k8stesting.Action) (bool, runtime.Object, error) {
		c.tableLists.Add(1)
		return false, nil, nil
	})
	kube := k8sfake.NewSimpleClientset(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: "lamorak-aaa", Namespace: ns,
		Labels: map[string]string{"app.kubernetes.io/name": "knight", "app.kubernetes.io/instance": "lamorak"},
	}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Name: "k", Image: "img"}}}})
	kube.PrependReactor("list", "pods", func(k8stesting.Action) (bool, runtime.Object, error) {
		c.podLists.Add(1)
		if c.failPods.Load() {
			return true, nil, errors.New("boom")
		}
		return false, nil, nil
	})

	oldDyn, oldKube, oldProbe := dynClient, k8sClient, metricsProbe
	oldNow, oldPTTL, oldProbeTTL := cacheNow, podSnapshotTTL, metricsProbeTTL
	now := time.Unix(1_000_000, 0)
	dynClient, k8sClient = dyn, kube
	cacheNow = func() time.Time { return now }
	podSnapshotTTL = 3 * time.Second
	metricsProbe = func() bool { c.probes.Add(1); return true }
	t.Cleanup(func() {
		dynClient, k8sClient, metricsProbe = oldDyn, oldKube, oldProbe
		cacheNow, podSnapshotTTL, metricsProbeTTL = oldNow, oldPTTL, oldProbeTTL
		resetListCache()
	})
	return c, &now
}

func getFleet(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	r := mux.NewRouter()
	r.HandleFunc("/api/fleet", fleetHandler("snapns"))
	r.HandleFunc("/api/fleet/{knight}", knightHandler("snapns"))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

func TestFleetPodSnapshotSharedWithinTTL(t *testing.T) {
	c, now := snapshotFixture(t)
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if w := getFleet(t, "/api/fleet"); w.Code != 200 {
				t.Errorf("fleet status %d: %s", w.Code, w.Body.String())
			}
		}()
	}
	wg.Wait()
	// The detail endpoint shares the same snapshot.
	if w := getFleet(t, "/api/fleet/lamorak"); w.Code != 200 {
		t.Fatalf("detail status %d: %s", w.Code, w.Body.String())
	}
	if p, m, rt, pr := c.podLists.Load(), c.metricLists.Load(), c.tableLists.Load(), c.probes.Load(); p != 1 || m != 1 || rt != 1 || pr != 1 {
		t.Fatalf("calls pods=%d metrics=%d roundtables=%d probes=%d, want 1 each", p, m, rt, pr)
	}

	*now = now.Add(podSnapshotTTL + time.Millisecond)
	getFleet(t, "/api/fleet")
	if p := c.podLists.Load(); p != 2 {
		t.Fatalf("pod lists after TTL = %d, want 2", p)
	}
}

func TestFleetPodSnapshotErrorNotCached(t *testing.T) {
	c, _ := snapshotFixture(t)
	c.failPods.Store(true)
	if w := getFleet(t, "/api/fleet"); w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	c.failPods.Store(false)
	getFleet(t, "/api/fleet")
	getFleet(t, "/api/fleet")
	if p := c.podLists.Load(); p != 2 {
		t.Fatalf("pod lists = %d, want 2 (failure retried once, success cached)", p)
	}
}

func TestKnightDetailCRFieldsNotFromSnapshot(t *testing.T) {
	_, _ = snapshotFixture(t)
	if w := getFleet(t, "/api/fleet/lamorak"); w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	// Change a CR field the detail serves while the pod snapshot is still
	// fresh: the detail must show the new value at once.
	cr, err := dynClient.Resource(knightGVR).Namespace("snapns").Get(context.Background(), "lamorak", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if err := unstructured.SetNestedSlice(cr.Object, []interface{}{
		map[string]interface{}{"name": "snap-new", "createdAt": "2026-01-01T00:00:00Z", "readyToUse": true},
	}, "status", "workspace", "snapshots"); err != nil {
		t.Fatal(err)
	}
	if _, err := dynClient.Resource(knightGVR).Namespace("snapns").Update(context.Background(), cr, metav1.UpdateOptions{}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		items, _ := cachedList(context.Background(), dynClient, knightGVR, "snapns")
		if len(items) == 1 && len(buildWorkspaceSnapshots(&items[0])) == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("informer did not pick up the update")
		}
		time.Sleep(20 * time.Millisecond)
	}
	w := getFleet(t, "/api/fleet/lamorak")
	if w.Code != 200 {
		t.Fatalf("status %d", w.Code)
	}
	var detail KnightDetail
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if len(detail.WorkspaceSnapshots) != 1 || detail.WorkspaceSnapshots[0].Name != "snap-new" {
		t.Fatalf("detail snapshots = %+v, want snap-new from the live CR", detail.WorkspaceSnapshots)
	}
}

func TestMetricsProbeCached(t *testing.T) {
	_, now := snapshotFixture(t)
	kube := k8sfake.NewSimpleClientset()
	k8sClient = kube
	metricsProbeTTL = 60 * time.Second
	for i := 0; i < 5; i++ {
		defaultMetricsProbe()
	}
	*now = now.Add(61 * time.Second)
	defaultMetricsProbe()
	// The fake discovery bypasses reactors, so assert the cache state: the
	// answer was stored once and refreshed only after the TTL.
	if probeCache.client != kube || !probeCache.at.Equal(*now) {
		t.Fatalf("probe cache not refreshed after TTL: %v vs %v", probeCache.at, *now)
	}
}

func TestKedaFallbackMemoised(t *testing.T) {
	_, now := snapshotFixture(t)
	var gets atomic.Int32
	dynClient.(*fake.FakeDynamicClient).PrependReactor("get", "scaledobjects", func(k8stesting.Action) (bool, runtime.Object, error) {
		gets.Add(1)
		return false, nil, nil
	})
	cr := makeTestKnightCR("solo", "snapns", "coding")
	for i := 0; i < 5; i++ {
		if s := buildKnightScaling(context.Background(), cr, nil); s.Autoscaled {
			t.Fatal("unexpected autoscaled")
		}
	}
	if g := gets.Load(); g != 1 {
		t.Fatalf("ScaledObject GETs = %d, want 1 (negative result memoised)", g)
	}
	*now = now.Add(kedaFallbackTTL + time.Second)
	buildKnightScaling(context.Background(), cr, nil)
	if g := gets.Load(); g != 2 {
		t.Fatalf("ScaledObject GETs after TTL = %d, want 2", g)
	}
}
