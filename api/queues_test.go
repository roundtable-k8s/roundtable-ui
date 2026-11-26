package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// fakeMsg is one message in a fake stream.
type fakeMsg struct {
	seq     uint64
	subject string
	time    time.Time
}

// fakeJetStream is an in-memory queueBackend.
type fakeJetStream struct {
	consumers   map[string]*jetstream.ConsumerInfo // "stream/consumer"
	messages    map[string][]fakeMsg               // stream -> messages by seq
	consumerErr error                              // returned for every ConsumerInfo when set
	mu          sync.Mutex
	lookups     []string // consumer names looked up
}

func newFakeJetStream() *fakeJetStream {
	return &fakeJetStream{consumers: map[string]*jetstream.ConsumerInfo{}, messages: map[string][]fakeMsg{}}
}

func (f *fakeJetStream) ConsumerInfo(_ context.Context, stream, consumer string) (*jetstream.ConsumerInfo, error) {
	f.mu.Lock()
	f.lookups = append(f.lookups, consumer)
	f.mu.Unlock()
	if f.consumerErr != nil {
		return nil, f.consumerErr
	}
	ci, ok := f.consumers[stream+"/"+consumer]
	if !ok {
		return nil, jetstream.ErrConsumerNotFound
	}
	return ci, nil
}

func (f *fakeJetStream) NextMsgTime(_ context.Context, stream string, seq uint64, subject string) (time.Time, error) {
	for _, m := range f.messages[stream] {
		if m.seq >= seq && subjectMatches(subject, m.subject) {
			return m.time, nil
		}
	}
	return time.Time{}, jetstream.ErrMsgNotFound
}

// subjectMatches supports the exact, "*" and trailing ">" forms the tests use.
func subjectMatches(filter, subject string) bool {
	ft, st := strings.Split(filter, "."), strings.Split(subject, ".")
	for i, tok := range ft {
		if tok == ">" {
			return len(st) > i
		}
		if i >= len(st) || (tok != "*" && tok != st[i]) {
			return false
		}
	}
	return len(ft) == len(st)
}

// withQueueFixture installs a fake JetStream and a fixed clock.
func withQueueFixture(t *testing.T, f *fakeJetStream, now time.Time) {
	t.Helper()
	prevQ, prevNow := queues, queueNow
	queues = f
	queueNow = func() time.Time { return now }
	t.Cleanup(func() { queues, queueNow = prevQ, prevNow })
}

func makeQueueKnightCR(name string, concurrency, readyReplicas int64) *unstructured.Unstructured {
	cr := makeTestKnightCR(name, "test-namespace", "dev")
	spec := cr.Object["spec"].(map[string]interface{})
	spec["concurrency"] = concurrency
	spec["nats"] = map[string]interface{}{"stream": "fleet_a_tasks"}
	status := cr.Object["status"].(map[string]interface{})
	status["ready"] = true
	status["natsConsumer"] = "knight-" + name
	status["replicas"] = readyReplicas
	status["readyReplicas"] = readyReplicas
	return cr
}

func createKnightCR(t *testing.T, cr *unstructured.Unstructured) {
	t.Helper()
	if _, err := dynClient.Resource(knightGVR).Namespace("test-namespace").Create(context.Background(), cr, metav1.CreateOptions{}); err != nil {
		t.Fatalf("create knight CR: %v", err)
	}
}

// dispatch appends n tasks for subject to the fake stream, one second apart
// starting at start, and returns their sequence numbers.
func dispatch(f *fakeJetStream, stream, subject string, n int, start time.Time) []uint64 {
	var seqs []uint64
	for i := 0; i < n; i++ {
		seq := uint64(len(f.messages[stream]) + 1)
		f.messages[stream] = append(f.messages[stream], fakeMsg{seq: seq, subject: subject, time: start.Add(time.Duration(i) * time.Second)})
		seqs = append(seqs, seq)
	}
	return seqs
}

func getQueue(t *testing.T, path string) *httptest.ResponseRecorder {
	t.Helper()
	router := setupTestRouter()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	return rr
}

func TestQueue_EmptyConsumer(t *testing.T) {
	f := newFakeJetStream()
	f.consumers["fleet_a_tasks/Gawain-consumer"] = &jetstream.ConsumerInfo{
		Config:     jetstream.ConsumerConfig{FilterSubject: "fleet-a.tasks.dev.>"},
		NumWaiting: 2,
	}
	q := buildKnightQueue(context.Background(), f, queueTargetFromCR(makeQueueKnightCR("gawain", 2, 1)))

	if !q.ConsumerFound || q.Consumer != "Gawain-consumer" {
		t.Fatalf("consumer = %q found=%v, want Gawain-consumer found", q.Consumer, q.ConsumerFound)
	}
	if q.Pending != 0 || q.AckPending != 0 || q.Waiting != 2 {
		t.Errorf("counters = %+v", q)
	}
	if q.OldestPendingAt != nil || q.OldestWaitSeconds != 0 {
		t.Errorf("empty queue has oldest %v / %vs", q.OldestPendingAt, q.OldestWaitSeconds)
	}
	if q.FreeSlots != 2 {
		t.Errorf("freeSlots = %d, want 2", q.FreeSlots)
	}
}

func TestQueue_Backlog(t *testing.T) {
	t0 := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	f := newFakeJetStream()
	// Another knight's task sits before ours in the shared stream.
	dispatch(f, "fleet_a_tasks", "fleet-a.tasks.ops.x", 1, t0.Add(-time.Hour))
	seqs := dispatch(f, "fleet_a_tasks", "fleet-a.tasks.dev.task", 10, t0)
	// The knight took two tasks (2 free slots) and has acked none.
	f.consumers["fleet_a_tasks/Gawain-consumer"] = &jetstream.ConsumerInfo{
		Config:        jetstream.ConsumerConfig{FilterSubjects: []string{"fleet-a.tasks.dev.>"}},
		NumPending:    8,
		NumAckPending: 2,
		Delivered:     jetstream.SequenceInfo{Consumer: 2, Stream: seqs[1]},
		AckFloor:      jetstream.SequenceInfo{Consumer: 0, Stream: 0},
	}
	target := queueTargetFromCR(makeQueueKnightCR("gawain", 2, 1))

	queueNow = func() time.Time { return t0.Add(30 * time.Second) }
	t.Cleanup(func() { queueNow = time.Now })
	q := buildKnightQueue(context.Background(), f, target)

	if q.Pending != 8 || q.AckPending != 2 {
		t.Errorf("pending=%d ackPending=%d, want 8/2", q.Pending, q.AckPending)
	}
	if q.FreeSlots != 0 {
		t.Errorf("freeSlots = %d, want 0", q.FreeSlots)
	}
	if q.Delivered.Stream != seqs[1] {
		t.Errorf("delivered.stream = %d, want %d", q.Delivered.Stream, seqs[1])
	}
	if q.OldestPendingAt == nil || !q.OldestPendingAt.Equal(t0) {
		t.Fatalf("oldestPendingAt = %v, want %v (other knights' tasks ignored)", q.OldestPendingAt, t0)
	}
	if q.OldestWaitSeconds != 30 {
		t.Errorf("oldestWaitSeconds = %v, want 30", q.OldestWaitSeconds)
	}

	// The oldest wait grows over time.
	queueNow = func() time.Time { return t0.Add(90 * time.Second) }
	if q2 := buildKnightQueue(context.Background(), f, target); q2.OldestWaitSeconds != 90 {
		t.Errorf("oldestWaitSeconds later = %v, want 90", q2.OldestWaitSeconds)
	}

	// Once the first two are acked the oldest is the third task.
	f.consumers["fleet_a_tasks/Gawain-consumer"].AckFloor = jetstream.SequenceInfo{Consumer: 2, Stream: seqs[1]}
	f.consumers["fleet_a_tasks/Gawain-consumer"].NumAckPending = 0
	q3 := buildKnightQueue(context.Background(), f, target)
	if want := t0.Add(2 * time.Second); q3.OldestPendingAt == nil || !q3.OldestPendingAt.Equal(want) {
		t.Errorf("oldest after acks = %v, want %v", q3.OldestPendingAt, want)
	}
	if q3.FreeSlots != 2 {
		t.Errorf("freeSlots after acks = %d, want 2", q3.FreeSlots)
	}
}

func TestQueue_AckPendingOnly(t *testing.T) {
	t0 := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	f := newFakeJetStream()
	seqs := dispatch(f, "fleet_a_tasks", "fleet-a.tasks.dev.task", 3, t0)
	f.consumers["fleet_a_tasks/Gawain-consumer"] = &jetstream.ConsumerInfo{
		Config:         jetstream.ConsumerConfig{FilterSubject: "fleet-a.tasks.dev.>"},
		NumPending:     0,
		NumAckPending:  1,
		NumRedelivered: 1,
		Delivered:      jetstream.SequenceInfo{Consumer: 3, Stream: seqs[2]},
		AckFloor:       jetstream.SequenceInfo{Consumer: 2, Stream: seqs[1]},
	}
	queueNow = func() time.Time { return t0.Add(time.Minute) }
	t.Cleanup(func() { queueNow = time.Now })

	q := buildKnightQueue(context.Background(), f, queueTargetFromCR(makeQueueKnightCR("gawain", 2, 1)))
	if q.Pending != 0 || q.AckPending != 1 || q.Redelivered != 1 {
		t.Errorf("counters = %+v", q)
	}
	if q.FreeSlots != 1 {
		t.Errorf("freeSlots = %d, want 1", q.FreeSlots)
	}
	if want := t0.Add(2 * time.Second); q.OldestPendingAt == nil || !q.OldestPendingAt.Equal(want) {
		t.Errorf("oldest = %v, want %v", q.OldestPendingAt, want)
	}
	if q.OldestWaitSeconds != 58 {
		t.Errorf("oldestWaitSeconds = %v, want 58", q.OldestWaitSeconds)
	}
}

func TestQueue_ConsumerFallbackAndMissing(t *testing.T) {
	f := newFakeJetStream()
	f.consumers["fleet_a_tasks/knight-gawain"] = &jetstream.ConsumerInfo{NumPending: 4}
	q := buildKnightQueue(context.Background(), f, queueTargetFromCR(makeQueueKnightCR("gawain", 2, 1)))
	if !q.ConsumerFound || q.Consumer != "knight-gawain" || q.Pending != 4 {
		t.Errorf("fallback to status.natsConsumer failed: %+v", q)
	}

	f = newFakeJetStream()
	q = buildKnightQueue(context.Background(), f, queueTargetFromCR(makeQueueKnightCR("gawain", 3, 2)))
	if q.ConsumerFound || q.Error != "" {
		t.Errorf("missing consumer: found=%v error=%q", q.ConsumerFound, q.Error)
	}
	if q.FreeSlots != 6 {
		t.Errorf("freeSlots without consumer = %d, want 6", q.FreeSlots)
	}
	if strings.Join(f.lookups, ",") != "Gawain-consumer,knight-gawain" {
		t.Errorf("lookups = %v", f.lookups)
	}
}

func TestQueue_BackendError(t *testing.T) {
	f := newFakeJetStream()
	f.consumerErr = errors.New("nats: timeout")
	q := buildKnightQueue(context.Background(), f, queueTargetFromCR(makeQueueKnightCR("gawain", 2, 1)))
	if q.Error == "" || q.ConsumerFound {
		t.Errorf("expected error, got %+v", q)
	}
	if strings.Contains(q.Error, "timeout") {
		t.Errorf("internal error leaked: %q", q.Error)
	}
	if len(f.lookups) != 1 {
		t.Errorf("should stop after a non-not-found error, lookups = %v", f.lookups)
	}
}

func TestQueueTargetFromCR_Defaults(t *testing.T) {
	cr := makeTestKnightCR("tristan", "test-namespace", "ops")
	cr.Object["status"].(map[string]interface{})["ready"] = true
	tg := queueTargetFromCR(cr)
	if tg.stream != defaultTasksStream || tg.concurrency != defaultConcurrency || tg.readyReplicas != 1 || tg.replicas != 1 {
		t.Errorf("defaults = %+v", tg)
	}
	if len(tg.consumers) != 1 || tg.consumers[0] != "Tristan-consumer" {
		t.Errorf("consumers = %v", tg.consumers)
	}

	notReady := makeTestKnightCR("tristan", "test-namespace", "ops")
	notReady.Object["status"] = map[string]interface{}{"phase": "Pending"}
	if tg := queueTargetFromCR(notReady); tg.readyReplicas != 0 {
		t.Errorf("not-ready readyReplicas = %d, want 0", tg.readyReplicas)
	}
}

func TestQueuesHandler(t *testing.T) {
	t0 := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	f := newFakeJetStream()
	dispatch(f, "fleet_a_tasks", "fleet-a.tasks.dev.task", 10, t0)
	f.consumers["fleet_a_tasks/Gawain-consumer"] = &jetstream.ConsumerInfo{
		Config:        jetstream.ConsumerConfig{FilterSubject: "fleet-a.tasks.dev.>"},
		NumPending:    8,
		NumAckPending: 2,
	}
	withQueueFixture(t, f, t0.Add(45*time.Second))

	router := setupTestRouter()
	createKnightCR(t, makeQueueKnightCR("gawain", 2, 1))
	createKnightCR(t, makeQueueKnightCR("bors", 2, 1))

	req := httptest.NewRequest(http.MethodGet, "/api/queues", nil)
	rr := httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rr.Code, rr.Body.String())
	}
	var got []KnightQueue
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 2 || got[0].Knight != "bors" || got[1].Knight != "gawain" {
		t.Fatalf("knights = %+v, want [bors gawain]", got)
	}
	if got[0].ConsumerFound || got[0].FreeSlots != 2 {
		t.Errorf("bors = %+v", got[0])
	}
	g := got[1]
	if g.Pending != 8 || g.AckPending != 2 || g.FreeSlots != 0 || g.OldestWaitSeconds != 45 {
		t.Errorf("gawain = %+v", g)
	}

	// Single-knight endpoint.
	req = httptest.NewRequest(http.MethodGet, "/api/fleet/gawain/queue", nil)
	rr = httptest.NewRecorder()
	router.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("knight queue status = %d: %s", rr.Code, rr.Body.String())
	}
	var one KnightQueue
	if err := json.Unmarshal(rr.Body.Bytes(), &one); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if one.Knight != "gawain" || one.Pending != 8 || one.Consumer != "Gawain-consumer" {
		t.Errorf("knight queue = %+v", one)
	}
}

func TestKnightQueueHandler_Errors(t *testing.T) {
	withQueueFixture(t, newFakeJetStream(), time.Now())

	if rr := getQueue(t, "/api/fleet/nobody/queue"); rr.Code != http.StatusNotFound {
		t.Errorf("unknown knight status = %d, want 404", rr.Code)
	}
	if rr := getQueue(t, "/api/fleet/Bad_Name/queue"); rr.Code != http.StatusBadRequest {
		t.Errorf("invalid name status = %d, want 400", rr.Code)
	}

	queues = nil
	if rr := getQueue(t, "/api/queues"); rr.Code != http.StatusServiceUnavailable {
		t.Errorf("no JetStream /queues status = %d, want 503", rr.Code)
	}
	if rr := getQueue(t, "/api/fleet/gawain/queue"); rr.Code != http.StatusServiceUnavailable {
		t.Errorf("no JetStream knight queue status = %d, want 503", rr.Code)
	}
}

func setQueuesTTL(t *testing.T, d time.Duration) {
	t.Helper()
	prev := queuesCacheTTL
	queuesCacheTTL = d
	t.Cleanup(func() { queuesCacheTTL = prev })
}

func lookupCount(f *fakeJetStream) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.lookups)
}

func TestQueuesHandler_SharedCache(t *testing.T) {
	t0 := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	f := newFakeJetStream()
	withQueueFixture(t, f, t0)
	setQueuesTTL(t, 200*time.Millisecond)

	router := setupTestRouter()
	createKnightCR(t, makeQueueKnightCR("gawain", 2, 1))
	bors := makeQueueKnightCR("bors", 2, 1)
	bors.SetLabels(map[string]string{labelRoundTable: "alpha"})
	createKnightCR(t, bors)

	get := func(path string) []KnightQueue {
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
		if rr.Code != http.StatusOK {
			t.Errorf("status = %d: %s", rr.Code, rr.Body.String())
		}
		var got []KnightQueue
		if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
			t.Errorf("decode: %v", err)
		}
		return got
	}

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); get("/api/queues") }()
	}
	wg.Wait()
	// One round: one lookup per knight (consumer not found falls through to
	// a second name, so allow up to two per knight).
	first := lookupCount(f)
	if first == 0 || first > 4 {
		t.Fatalf("lookups after 20 concurrent requests = %d, want one round (<=4)", first)
	}

	// Within the TTL: served from cache, incl. filtered requests.
	get("/api/queues")
	if got := get("/api/queues?table=nonexistent"); len(got) != 0 {
		t.Errorf("table filter returned %+v, want none", got)
	}
	if got := get("/api/queues?table=alpha"); len(got) != 1 || got[0].Knight != "bors" {
		t.Errorf("table=alpha returned %+v, want [bors]", got)
	}
	if got := get("/api/queues?table=none"); len(got) != 1 || got[0].Knight != "gawain" {
		t.Errorf("table=none returned %+v, want [gawain]", got)
	}
	if n := lookupCount(f); n != first {
		t.Errorf("lookups within TTL = %d, want %d", n, first)
	}

	// After the TTL: a new round.
	time.Sleep(250 * time.Millisecond)
	get("/api/queues")
	if n := lookupCount(f); n != 2*first {
		t.Errorf("lookups after TTL = %d, want %d", n, 2*first)
	}
}

func TestQueuesHandler_ErrorsNotCached(t *testing.T) {
	setQueuesTTL(t, time.Minute)
	c := &queuesCache{}
	calls := 0
	_, err := c.get(context.Background(), func(context.Context) ([]KnightQueue, error) {
		calls++
		return nil, errors.New("boom")
	})
	if err == nil {
		t.Fatal("want error")
	}
	if _, err = c.get(context.Background(), func(context.Context) ([]KnightQueue, error) {
		calls++
		return []KnightQueue{{Knight: "a"}}, nil
	}); err != nil || calls != 2 {
		t.Fatalf("err=%v calls=%d, want a retry after the failure", err, calls)
	}
}

func TestQueuesCache_BuildSurvivesCallerCancel(t *testing.T) {
	c := &queuesCache{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	errc := make(chan error, 1)
	c.get(ctx, func(bctx context.Context) ([]KnightQueue, error) {
		time.Sleep(20 * time.Millisecond)
		errc <- bctx.Err()
		return []KnightQueue{}, nil
	})
	if buildErr := <-errc; buildErr != nil {
		t.Errorf("build context was cancelled with the caller: %v", buildErr)
	}
}
