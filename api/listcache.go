package main

import (
	"context"
	"sort"
	"sync"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

// Watch-backed read cache (#313): the hot list endpoints (triggers, missions,
// the chain/knight lookups behind /api/running) are served from an informer
// store instead of listing from the Kubernetes API on every request. The
// informer starts on first use, lists once and then follows a watch, so new
// objects show up within moments. Needs list + watch on the cached resources;
// if the informer can't sync (e.g. watch is forbidden) reads fall back to a
// direct list.

// listCacheSyncTimeout bounds how long a read waits for an informer's first sync.
const listCacheSyncTimeout = 5 * time.Second

// listCacheSyncTimeoutVar is the effective timeout (overridable in tests).
var listCacheSyncTimeoutVar = listCacheSyncTimeout

type listCacheKey struct {
	client    dynamic.Interface
	gvr       schema.GroupVersionResource
	namespace string
}

// listCacheFailTTL is how long a failed first sync is remembered: reads go
// straight to a direct list meanwhile, so only the first reader pays the wait.
const listCacheFailTTL = 30 * time.Second

type listCacheEntry struct {
	inf  cache.SharedIndexInformer
	stop chan struct{}
	// failedAt is when a first sync last timed out (zero if it hasn't).
	failedAt time.Time
}

var (
	listCacheMu        sync.Mutex
	listCacheInformers = map[listCacheKey]*listCacheEntry{}
)

// resetListCache stops every informer and clears the registry (for tests).
func resetListCache() {
	listCacheMu.Lock()
	defer listCacheMu.Unlock()
	for k, e := range listCacheInformers {
		close(e.stop)
		delete(listCacheInformers, k)
	}
}

// cachedList returns the objects of gvr in namespace from the watch cache,
// sorted by name. Callers must not modify the returned objects.
func cachedList(ctx context.Context, client dynamic.Interface, gvr schema.GroupVersionResource, namespace string) ([]unstructured.Unstructured, error) {
	key := listCacheKey{client, gvr, namespace}
	listCacheMu.Lock()
	e, ok := listCacheInformers[key]
	if !ok {
		e = &listCacheEntry{
			inf: dynamicinformer.NewFilteredDynamicInformer(client, gvr, namespace, 0,
				cache.Indexers{}, nil).Informer(),
			stop: make(chan struct{}),
		}
		listCacheInformers[key] = e
		go e.inf.Run(e.stop)
	}
	inf := e.inf
	recentlyFailed := !inf.HasSynced() && !e.failedAt.IsZero() && time.Since(e.failedAt) < listCacheFailTTL
	listCacheMu.Unlock()

	direct := func() ([]unstructured.Unstructured, error) {
		list, err := client.Resource(gvr).Namespace(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, err
		}
		return list.Items, nil
	}
	if recentlyFailed {
		return direct()
	}
	syncCtx, cancel := context.WithTimeout(ctx, listCacheSyncTimeoutVar)
	defer cancel()
	if !cache.WaitForCacheSync(syncCtx.Done(), inf.HasSynced) {
		// Remember only a real sync timeout, not a cancelled caller.
		if ctx.Err() == nil {
			listCacheMu.Lock()
			e.failedAt = time.Now()
			listCacheMu.Unlock()
		}
		return direct()
	}
	objs := inf.GetStore().List()
	out := make([]unstructured.Unstructured, 0, len(objs))
	for _, o := range objs {
		if u, ok := o.(*unstructured.Unstructured); ok {
			out = append(out, *u)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetName() < out[j].GetName() })
	return out, nil
}
