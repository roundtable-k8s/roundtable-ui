package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/nats-io/nats.go/jetstream"
	"golang.org/x/sync/singleflight"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Queue observability (#204): per-knight JetStream consumer backlog.

// defaultTasksStream matches the Knight CRD default for spec.nats.stream.
const defaultTasksStream = "fleet_a_tasks"

// defaultConcurrency matches the Knight CRD default for spec.concurrency.
const defaultConcurrency = 2

// queueLookupTimeout bounds the JetStream calls behind one queue request.
const queueLookupTimeout = 5 * time.Second

// queueBackend is the slice of JetStream the queue endpoints need. It is an
// interface so tests can run against a fake JetStream.
type queueBackend interface {
	// ConsumerInfo returns the state of a durable consumer on a stream.
	ConsumerInfo(ctx context.Context, stream, consumer string) (*jetstream.ConsumerInfo, error)
	// NextMsgTime returns the timestamp of the first message in the stream
	// with sequence >= seq matching subject (wildcards allowed). It returns
	// jetstream.ErrMsgNotFound when there is none.
	NextMsgTime(ctx context.Context, stream string, seq uint64, subject string) (time.Time, error)
}

// jsQueueBackend is the production queueBackend backed by the API's
// JetStream handle.
type jsQueueBackend struct{ js jetstream.JetStream }

func (b jsQueueBackend) ConsumerInfo(ctx context.Context, stream, consumer string) (*jetstream.ConsumerInfo, error) {
	c, err := b.js.Consumer(ctx, stream, consumer)
	if err != nil {
		return nil, err
	}
	// Consumer() already fetched the info; no second round trip.
	return c.CachedInfo(), nil
}

func (b jsQueueBackend) NextMsgTime(ctx context.Context, stream string, seq uint64, subject string) (time.Time, error) {
	s, err := b.js.Stream(ctx, stream)
	if err != nil {
		return time.Time{}, err
	}
	msg, err := s.GetMsg(ctx, seq, jetstream.WithGetMsgSubject(subject))
	if err != nil {
		return time.Time{}, err
	}
	return msg.Time, nil
}

// queues is the backend used by the queue handlers; nil means JetStream is
// unavailable. main sets it after connecting; tests replace it.
var queues queueBackend

// queueNow is the clock used for oldest-wait ages (overridable in tests).
var queueNow = time.Now

// SequenceDTO mirrors jetstream.SequenceInfo.
type SequenceDTO struct {
	Consumer uint64     `json:"consumerSeq"`
	Stream   uint64     `json:"streamSeq"`
	Last     *time.Time `json:"lastActive,omitempty"`
}

// KnightQueue is the queue state of one knight's durable task consumer.
type KnightQueue struct {
	Knight string `json:"knight"`
	// Table is the knight's RoundTable, "none" when unset (#273).
	Table    string `json:"table"`
	Stream   string `json:"stream"`
	Consumer string `json:"consumer"`
	// ConsumerFound is false when no durable consumer exists yet (knight
	// never started) — the counters are then all zero.
	ConsumerFound bool `json:"consumerFound"`

	// Pending is the number of messages not yet delivered (NumPending).
	Pending uint64 `json:"pending"`
	// AckPending is delivered but not yet acknowledged (in flight).
	AckPending int `json:"ackPending"`
	// Redelivered is the number of messages redelivered and not yet acked.
	Redelivered int `json:"redelivered"`
	// Waiting is the number of pull requests waiting for messages.
	Waiting   int         `json:"waiting"`
	Delivered SequenceDTO `json:"delivered"`
	AckFloor  SequenceDTO `json:"ackFloor"`

	// OldestPendingAt is when the oldest unacknowledged message (the first
	// message after the ack floor) was published; nil with nothing waiting.
	OldestPendingAt *time.Time `json:"oldestPendingAt,omitempty"`
	// OldestWaitSeconds is how long that message has been waiting.
	OldestWaitSeconds float64 `json:"oldestWaitSeconds"`

	Concurrency   int32 `json:"concurrency"`
	Replicas      int32 `json:"replicas"`
	ReadyReplicas int32 `json:"readyReplicas"`
	// FreeSlots = concurrency × readyReplicas − in-flight (ack-pending),
	// never negative.
	FreeSlots int `json:"freeSlots"`

	// Error is set when the consumer could not be read (other than
	// not-found); the counters are then zero.
	Error string `json:"error,omitempty"`
}

// queueTarget is what the queue lookup needs from a Knight CR.
type queueTarget struct {
	knight        string
	table         string
	stream        string
	consumers     []string // candidate durable names, in lookup order
	concurrency   int32
	replicas      int32
	readyReplicas int32
}

// queueTargetFromCR derives the stream, consumer candidates and capacity
// from a Knight CR.
func queueTargetFromCR(cr *unstructured.Unstructured) queueTarget {
	spec := getNestedMap(cr.Object, "spec")
	status := getNestedMap(cr.Object, "status")
	natsSpec := getNestedMap(spec, "nats")

	t := queueTarget{knight: cr.GetName(), table: tableOrNone(knightTableName(cr))}

	t.stream = getStr(natsSpec, "stream")
	if t.stream == "" {
		t.stream = defaultTasksStream
	}

	// The runtimes create "<Knight>-consumer" (capitalised knight name) and
	// KEDA scales on it; status.natsConsumer is the operator's recorded name
	// and is tried next when it differs.
	t.consumers = []string{capitalizeKnight(t.knight) + "-consumer"}
	if c := getStr(status, "natsConsumer"); c != "" && c != t.consumers[0] {
		t.consumers = append(t.consumers, c)
	}

	t.concurrency = int32(getInt(spec, "concurrency"))
	if t.concurrency <= 0 {
		t.concurrency = defaultConcurrency
	}

	t.replicas = int32(getInt(status, "replicas"))
	if _, ok := status["readyReplicas"]; ok {
		t.readyReplicas = int32(getInt(status, "readyReplicas"))
	} else if knightIsReady(cr) {
		// Operators without replica status (or readyReplicas omitted as
		// zero): fall back to the ready flag.
		t.readyReplicas = 1
	}
	if t.replicas < t.readyReplicas {
		t.replicas = t.readyReplicas
	}
	return t
}

// consumerSubjects returns the subjects the consumer reads, or ">" when it
// has no filter.
func consumerSubjects(cfg jetstream.ConsumerConfig) []string {
	if len(cfg.FilterSubjects) > 0 {
		return cfg.FilterSubjects
	}
	if cfg.FilterSubject != "" {
		return []string{cfg.FilterSubject}
	}
	return []string{">"}
}

// buildKnightQueue reads the consumer info and oldest-pending age for one
// knight.
func buildKnightQueue(ctx context.Context, b queueBackend, t queueTarget) KnightQueue {
	q := KnightQueue{
		Knight:        t.knight,
		Table:         t.table,
		Stream:        t.stream,
		Consumer:      t.consumers[0],
		Concurrency:   t.concurrency,
		Replicas:      t.replicas,
		ReadyReplicas: t.readyReplicas,
	}
	capacity := int(t.concurrency) * int(t.readyReplicas)
	q.FreeSlots = capacity

	var info *jetstream.ConsumerInfo
	for _, name := range t.consumers {
		ci, err := b.ConsumerInfo(ctx, t.stream, name)
		if err == nil {
			info, q.Consumer = ci, name
			break
		}
		if !errors.Is(err, jetstream.ErrConsumerNotFound) {
			slog.WarnContext(ctx, "queue: consumer info failed", "knight", t.knight, "stream", t.stream, "consumer", name, "error", err)
			q.Consumer = name
			q.Error = "failed to read consumer info"
			return q
		}
	}
	if info == nil {
		return q
	}

	q.ConsumerFound = true
	q.Pending = info.NumPending
	q.AckPending = info.NumAckPending
	q.Redelivered = info.NumRedelivered
	q.Waiting = info.NumWaiting
	q.Delivered = SequenceDTO{Consumer: info.Delivered.Consumer, Stream: info.Delivered.Stream, Last: info.Delivered.Last}
	q.AckFloor = SequenceDTO{Consumer: info.AckFloor.Consumer, Stream: info.AckFloor.Stream, Last: info.AckFloor.Last}

	q.FreeSlots = capacity - info.NumAckPending
	if q.FreeSlots < 0 {
		q.FreeSlots = 0
	}

	if info.NumPending == 0 && info.NumAckPending == 0 {
		return q
	}

	// Oldest unacked message: the first one after the ack floor on any of
	// the consumer's subjects (the stream may hold other knights' tasks).
	start := info.AckFloor.Stream + 1
	var oldest time.Time
	for _, subj := range consumerSubjects(info.Config) {
		ts, err := b.NextMsgTime(ctx, t.stream, start, subj)
		if err != nil {
			if !errors.Is(err, jetstream.ErrMsgNotFound) {
				slog.WarnContext(ctx, "queue: oldest message lookup failed", "knight", t.knight, "stream", t.stream, "seq", start, "error", err)
			}
			continue
		}
		if oldest.IsZero() || ts.Before(oldest) {
			oldest = ts
		}
	}
	if !oldest.IsZero() {
		q.OldestPendingAt = &oldest
		if age := queueNow().Sub(oldest).Seconds(); age > 0 {
			q.OldestWaitSeconds = age
		}
	}
	return q
}

// knightQueueHandler serves GET /api/fleet/{knight}/queue.
func knightQueueHandler(namespace string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := mux.Vars(r)["knight"]
		if !validK8sName.MatchString(name) {
			jsonError(w, "Invalid knight name", http.StatusBadRequest)
			return
		}
		if dynClient == nil {
			jsonError(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}
		b := queues
		if b == nil {
			jsonError(w, "JetStream not available", http.StatusServiceUnavailable)
			return
		}
		cr, err := dynClient.Resource(knightGVR).Namespace(namespace).Get(r.Context(), name, metav1.GetOptions{})
		if err != nil {
			writeGetError(w, r, err, "Knight", "knight", name)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), queueLookupTimeout)
		defer cancel()
		q := buildKnightQueue(ctx, b, queueTargetFromCR(cr))

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(q)
	}
}

// queuesCacheTTL is how long one /api/queues lookup is shared between
// requests. It is a variable so tests can change it.
var queuesCacheTTL = 3 * time.Second

// queuesCache holds the last unfiltered /api/queues result and collapses
// concurrent misses into one build. Errors are never cached.
type queuesCache struct {
	mu    sync.Mutex
	at    time.Time
	items []KnightQueue
	group singleflight.Group
}

func (c *queuesCache) fresh() ([]KnightQueue, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.items != nil && time.Since(c.at) < queuesCacheTTL {
		return c.items, true
	}
	return nil, false
}

// get returns the sorted queues of every knight. build runs at most once for
// concurrent callers, under its own context bounded by queueLookupTimeout so
// one caller going away does not fail the others.
func (c *queuesCache) get(ctx context.Context, build func(context.Context) ([]KnightQueue, error)) ([]KnightQueue, error) {
	if items, ok := c.fresh(); ok {
		return items, nil
	}
	ch := c.group.DoChan("queues", func() (any, error) {
		if items, ok := c.fresh(); ok {
			return items, nil
		}
		bctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), queueLookupTimeout)
		defer cancel()
		items, err := build(bctx)
		if err != nil {
			return nil, err
		}
		if items == nil {
			items = []KnightQueue{}
		}
		c.mu.Lock()
		c.items, c.at = items, time.Now()
		c.mu.Unlock()
		return items, nil
	})
	select {
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		return res.Val.([]KnightQueue), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// queuesHandler serves GET /api/queues: the queue of every knight, sorted by
// name. The unfiltered lookup is shared for queuesCacheTTL; ?table= filters
// the shared result.
func queuesHandler(namespace string) http.HandlerFunc {
	cache := &queuesCache{}
	return func(w http.ResponseWriter, r *http.Request) {
		if dynClient == nil {
			jsonError(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}
		b := queues
		if b == nil {
			jsonError(w, "JetStream not available", http.StatusServiceUnavailable)
			return
		}
		all, err := cache.get(r.Context(), func(ctx context.Context) ([]KnightQueue, error) {
			crItems, err := cachedList(ctx, dynClient, knightGVR, namespace)
			if err != nil {
				return nil, err
			}
			// Look up knights concurrently, a few at a time.
			out := make([]KnightQueue, len(crItems))
			sem := make(chan struct{}, 8)
			var wg sync.WaitGroup
			for i := range crItems {
				wg.Add(1)
				sem <- struct{}{}
				go func(i int) {
					defer wg.Done()
					defer func() { <-sem }()
					out[i] = buildKnightQueue(ctx, b, queueTargetFromCR(&crItems[i]))
				}(i)
			}
			wg.Wait()
			sort.Slice(out, func(i, j int) bool { return out[i].Knight < out[j].Knight })
			return out, nil
		})
		if err != nil {
			slog.ErrorContext(r.Context(), "K8s knight CR list error", "error", err)
			jsonError(w, "Failed to list knights", http.StatusInternalServerError)
			return
		}

		filter := tableFilter(r)
		out := make([]KnightQueue, 0, len(all))
		for _, q := range all {
			if tableMatches(filter, q.Table) {
				out = append(out, q)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	}
}
