package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
)

// Chain change operations carried in the "op" field of a chain WS event.
const (
	chainOpUpsert = "upsert"
	chainOpDelete = "delete"
)

// chainWatcher watches Chain resources through the Kubernetes API and fans
// every add/update/delete out to WebSocket clients as a "chain" message whose
// data is the same full ChainSummary served by /api/chains/{name} (#228); the
// GET /api/chains list is slim (#275), so a push also carries step detail.
//
// The operator does not publish chain progress over NATS, so the watch is the
// only live source. On watch expiry or error the watcher re-lists and emits
// the diff against what it last saw, so a client never misses a final state.
type chainWatcher struct {
	client    dynamic.Interface
	namespace string
	// domains resolves knight name → domain and plan-backing for ChainSummary
	// step domains and notional cost.
	domains func(ctx context.Context) map[string]knightInfo
	// running is the in-flight registry joined onto every pushed chain so a
	// status change does not wipe the pod/heartbeat the UI got from REST (#227).
	running *runningRegistry
	// backoff is the delay before retrying after a failed list/watch.
	backoff time.Duration

	mu      sync.Mutex
	subs    map[int]func([]byte)
	nextSub int
	// seen tracks the last resourceVersion emitted per chain name, used to
	// diff after a re-list.
	seen map[string]string
}

func newChainWatcher(client dynamic.Interface, namespace string, running *runningRegistry) *chainWatcher {
	return &chainWatcher{
		client:    client,
		namespace: namespace,
		running:   running,
		domains:   cachedDomains(5*time.Second, func(ctx context.Context) map[string]knightInfo { return knightInfoMap(ctx, client, namespace) }),
		backoff:   2 * time.Second,
		subs:      map[int]func([]byte){},
		seen:      map[string]string{},
	}
}

// subscribe registers fn to receive encoded chain events. fn must not block
// (the WS writer only enqueues). The returned func unsubscribes.
func (c *chainWatcher) subscribe(fn func([]byte)) func() {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.nextSub
	c.nextSub++
	c.subs[id] = fn
	return func() {
		c.mu.Lock()
		delete(c.subs, id)
		c.mu.Unlock()
	}
}

func (c *chainWatcher) broadcast(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, fn := range c.subs {
		fn(data)
	}
}

// chainWSEvent encodes a chain change in the shared TaskEvent envelope.
func chainWSEvent(op string, summary ChainSummary) []byte {
	payload, _ := json.Marshal(summary)
	data, _ := json.Marshal(TaskEvent{
		Type:      "chain",
		Op:        op,
		Subject:   "chains." + summary.Name,
		Data:      payload,
		Timestamp: time.Now().UTC(),
	})
	return data
}

func (c *chainWatcher) hasSubscribers() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.subs) > 0
}

// emit encodes and broadcasts one change. domains is resolved lazily (and at
// most once per call site via the pointer) since it costs a Knight list.
func (c *chainWatcher) emit(ctx context.Context, op string, obj *unstructured.Unstructured, domains *map[string]knightInfo) {
	if !c.hasSubscribers() {
		return
	}
	if op != chainOpDelete && *domains == nil {
		*domains = c.domains(ctx)
	}
	summary := parseChainResource(obj.Object, *domains)
	if op != chainOpDelete {
		joinChainInFlight(&summary, c.running)
	}
	c.broadcast(chainWSEvent(op, summary))
}

// cachedDomains memoises fn for ttl so a burst of chain changes costs one
// Knight list instead of one per change. The result is cached even when the list
// failed (knightInfoMap then returns an empty map), so a failing list is
// retried at most once per ttl.
func cachedDomains(ttl time.Duration, fn func(ctx context.Context) map[string]knightInfo) func(ctx context.Context) map[string]knightInfo {
	var (
		mu     sync.Mutex
		at     time.Time
		last   map[string]knightInfo
		cached bool
	)
	return func(ctx context.Context) map[string]knightInfo {
		mu.Lock()
		defer mu.Unlock()
		if cached && time.Since(at) < ttl {
			return last
		}
		last = fn(ctx)
		at = time.Now()
		cached = true
		return last
	}
}

// run lists and watches until ctx is cancelled.
func (c *chainWatcher) run(ctx context.Context) {
	for ctx.Err() == nil {
		rv, err := c.relist(ctx)
		if err != nil {
			if ctx.Err() == nil {
				slog.WarnContext(ctx, "Chain list failed, retrying", "error", err)
			}
			c.sleep(ctx)
			continue
		}
		// Keep watching from the latest resourceVersion; fall back to a
		// re-list only when the watch reports an error (e.g. 410 Gone).
		for ctx.Err() == nil {
			next, ok := c.watchOnce(ctx, rv)
			if !ok {
				break
			}
			rv = next
		}
		if ctx.Err() == nil {
			c.sleep(ctx)
		}
	}
}

func (c *chainWatcher) sleep(ctx context.Context) {
	t := time.NewTimer(c.backoff)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// relist fetches all chains, emits upserts for any chain new or changed since
// last seen and deletes for chains that disappeared. Returns the list's
// resourceVersion to watch from.
func (c *chainWatcher) relist(ctx context.Context) (string, error) {
	list, err := c.client.Resource(chainGVR).Namespace(c.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return "", err
	}
	var domains map[string]knightInfo
	present := make(map[string]bool, len(list.Items))
	for i := range list.Items {
		item := &list.Items[i]
		name := item.GetName()
		present[name] = true
		if prev, ok := c.seen[name]; ok && prev == item.GetResourceVersion() {
			continue
		}
		c.seen[name] = item.GetResourceVersion()
		c.emit(ctx, chainOpUpsert, item, &domains)
	}
	for name := range c.seen {
		if present[name] {
			continue
		}
		delete(c.seen, name)
		gone := &unstructured.Unstructured{Object: map[string]interface{}{}}
		gone.SetName(name)
		gone.SetNamespace(c.namespace)
		c.emit(ctx, chainOpDelete, gone, &domains)
	}
	return list.GetResourceVersion(), nil
}

// watchOnce consumes one watch stream. It returns the last resourceVersion
// observed and true when the stream ended normally (server timeout) and can be
// resumed, or false when a re-list is required.
func (c *chainWatcher) watchOnce(ctx context.Context, rv string) (string, bool) {
	w, err := c.client.Resource(chainGVR).Namespace(c.namespace).Watch(ctx, metav1.ListOptions{
		ResourceVersion:     rv,
		AllowWatchBookmarks: true,
	})
	if err != nil {
		if ctx.Err() == nil {
			slog.WarnContext(ctx, "Chain watch failed, re-listing", "error", err)
		}
		return rv, false
	}
	defer w.Stop()
	for {
		select {
		case <-ctx.Done():
			return rv, false
		case ev, ok := <-w.ResultChan():
			if !ok {
				// Server closed the stream (watch timeout); resume from rv.
				return rv, true
			}
			switch ev.Type {
			case watch.Error:
				status := apierrors.FromObject(ev.Object)
				slog.InfoContext(ctx, "Chain watch ended with error, re-listing", "reason", apierrors.ReasonForError(status), "error", status)
				return rv, false
			case watch.Bookmark:
				if obj, ok := ev.Object.(*unstructured.Unstructured); ok {
					rv = obj.GetResourceVersion()
				}
			case watch.Added, watch.Modified, watch.Deleted:
				obj, ok := ev.Object.(*unstructured.Unstructured)
				if !ok {
					continue
				}
				rv = obj.GetResourceVersion()
				name := obj.GetName()
				var domains map[string]knightInfo
				if ev.Type == watch.Deleted {
					delete(c.seen, name)
					c.emit(ctx, chainOpDelete, obj, &domains)
				} else {
					c.seen[name] = obj.GetResourceVersion()
					c.emit(ctx, chainOpUpsert, obj, &domains)
				}
			}
		}
	}
}
