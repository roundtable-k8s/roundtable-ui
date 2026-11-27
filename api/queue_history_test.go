package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/nats-io/nats.go/jetstream"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

// fakeQueueEnv is a fake JetStream + Kubernetes behind a queueSampler.
type fakeQueueEnv struct {
	now       time.Time
	knights   map[string]map[string]interface{}  // name -> status
	consumers map[string]*jetstream.ConsumerInfo // stream/consumer -> info
	events    []corev1.Event
	calls     []string
}

func newFakeQueueEnv(t *testing.T) (*fakeQueueEnv, *queueSampler) {
	t.Helper()
	env := &fakeQueueEnv{
		now:       time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC),
		knights:   map[string]map[string]interface{}{},
		consumers: map[string]*jetstream.ConsumerInfo{},
	}
	s := newQueueSampler(queueSampleInterval, queueHistoryRetention)
	s.now = func() time.Time { return env.now }
	s.listKnights = func(context.Context) ([]unstructured.Unstructured, error) {
		var out []unstructured.Unstructured
		for name, status := range env.knights {
			u := unstructured.Unstructured{Object: map[string]interface{}{
				"spec":   map[string]interface{}{"nats": map[string]interface{}{"stream": "fleet_a_tasks"}},
				"status": status,
			}}
			u.SetName(name)
			out = append(out, u)
		}
		return out, nil
	}
	s.consumerInfo = func(_ context.Context, stream, consumer string) (*jetstream.ConsumerInfo, error) {
		env.calls = append(env.calls, stream+"/"+consumer)
		if info, ok := env.consumers[stream+"/"+consumer]; ok {
			return info, nil
		}
		return nil, jetstream.ErrConsumerNotFound
	}
	s.listEvents = func(context.Context) ([]corev1.Event, error) { return env.events, nil }
	return env, s
}

func (e *fakeQueueEnv) tick(s *queueSampler) {
	s.sampleOnce(context.Background())
	e.now = e.now.Add(queueSampleInterval)
}

func hpaEvent(uid, knight, msg string, at time.Time) corev1.Event {
	return corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{UID: types.UID(uid)},
		InvolvedObject: corev1.ObjectReference{Kind: "HorizontalPodAutoscaler", Name: kedaHPAPrefix + knight},
		Reason:         "SuccessfulRescale",
		Message:        msg,
		Count:          1,
		LastTimestamp:  metav1.NewTime(at),
	}
}

func TestRingBufferWrapsOldestFirst(t *testing.T) {
	r := newRing[int](3)
	if _, ok := r.last(); ok {
		t.Fatal("empty ring should have no last")
	}
	for i := 1; i <= 5; i++ {
		r.push(i)
	}
	got := r.items()
	if len(got) != 3 || got[0] != 3 || got[1] != 4 || got[2] != 5 {
		t.Fatalf("items = %v, want [3 4 5]", got)
	}
	if v, _ := r.last(); v != 5 {
		t.Fatalf("last = %d, want 5", v)
	}
}

func TestQueueSamplerCapacityCoversSixHours(t *testing.T) {
	s := newQueueSampler(queueSampleInterval, queueHistoryRetention)
	if got := s.capacity(); got != 1440 {
		t.Fatalf("capacity = %d, want 1440 (6h / 15s)", got)
	}
}

func TestKnightTargetDefaultsAndScaling(t *testing.T) {
	u := unstructured.Unstructured{Object: map[string]interface{}{
		"spec": map[string]interface{}{"maxReplicas": int64(4)},
		"status": map[string]interface{}{
			"replicas": int64(2), "readyReplicas": int64(1),
		},
	}}
	u.SetName("galahad")
	tg := knightTarget(&u)
	if tg.stream != defaultTasksStream || tg.consumer != "Galahad-consumer" {
		t.Fatalf("stream/consumer = %q/%q", tg.stream, tg.consumer)
	}
	if tg.replicas != 2 || tg.ready != 1 || tg.max == nil || *tg.max != 4 || tg.desired != nil {
		t.Fatalf("unexpected target %+v", tg)
	}

	u.Object["status"] = map[string]interface{}{
		"natsConsumer": "custom",
		"scaling":      map[string]interface{}{"desiredReplicas": int64(3), "maxReplicas": int64(5)},
	}
	tg = knightTarget(&u)
	if tg.consumer != "custom" || *tg.desired != 3 || *tg.max != 5 {
		t.Fatalf("status.scaling not used: %+v", tg)
	}
}

func TestQueueSamplerEmptyQueue(t *testing.T) {
	env, s := newFakeQueueEnv(t)
	env.knights["kay"] = map[string]interface{}{"replicas": int64(1), "readyReplicas": int64(1)}
	env.consumers["fleet_a_tasks/Kay-consumer"] = &jetstream.ConsumerInfo{}
	env.tick(s)

	h := s.history("kay", 0)
	if len(h.Samples) != 1 || h.Samples[0].Pending == nil || *h.Samples[0].Pending != 0 {
		t.Fatalf("want one zero-pending sample, got %+v", h.Samples)
	}
	if len(h.Events) != 0 {
		t.Fatalf("want no events, got %+v", h.Events)
	}
	if h.IntervalSeconds != 15 || h.RetentionSeconds != 21600 {
		t.Fatalf("interval/retention = %d/%d", h.IntervalSeconds, h.RetentionSeconds)
	}
}

func TestQueueSamplerAckPendingOnly(t *testing.T) {
	env, s := newFakeQueueEnv(t)
	env.knights["kay"] = map[string]interface{}{"replicas": int64(1), "readyReplicas": int64(1)}
	env.consumers["fleet_a_tasks/Kay-consumer"] = &jetstream.ConsumerInfo{NumAckPending: 2, NumRedelivered: 1}
	env.tick(s)

	smp := s.history("kay", 0).Samples[0]
	if *smp.Pending != 0 || *smp.AckPending != 2 || *smp.Redelivered != 1 {
		t.Fatalf("unexpected sample %+v", smp)
	}
}

func TestQueueSamplerConsumerErrorLeavesGap(t *testing.T) {
	env, s := newFakeQueueEnv(t)
	env.knights["kay"] = map[string]interface{}{"replicas": int64(0)}
	env.tick(s) // no consumer registered -> ErrConsumerNotFound

	smp := s.history("kay", 0).Samples[0]
	if smp.Pending != nil || smp.AckPending != nil {
		t.Fatalf("queue fields should be null on error, got %+v", smp)
	}
	raw, _ := json.Marshal(smp)
	var m map[string]interface{}
	json.Unmarshal(raw, &m)
	if v, ok := m["pending"]; !ok || v != nil {
		t.Fatalf("pending should serialise as null, got %s", raw)
	}
}

// Acceptance (#205): a KEDA scale-up during a backlog is visible in the
// sampled history with its reason.
func TestQueueSamplerKEDAScaleUpDuringBacklog(t *testing.T) {
	env, s := newFakeQueueEnv(t)
	env.knights["kay"] = map[string]interface{}{"replicas": int64(1), "readyReplicas": int64(1)}
	info := &jetstream.ConsumerInfo{NumPending: 8, NumAckPending: 2}
	env.consumers["fleet_a_tasks/Kay-consumer"] = info
	env.tick(s)
	env.tick(s)

	// KEDA's HPA scales up on the backlog
	reason := "external metric s0-nats-jetstream-fleet_a_tasks(&LabelSelector{}) above target"
	env.events = []corev1.Event{
		hpaEvent("e1", "kay", "New size: 3; reason: "+reason, env.now.Add(-time.Second)),
		// an HPA that is not KEDA's and an event for an unknown knight are ignored
		{
			ObjectMeta:     metav1.ObjectMeta{UID: "e2"},
			InvolvedObject: corev1.ObjectReference{Kind: "HorizontalPodAutoscaler", Name: "other-hpa"},
			Reason:         "SuccessfulRescale", Message: "New size: 2; reason: cpu", LastTimestamp: metav1.NewTime(env.now),
		},
		hpaEvent("e3", "ghost", "New size: 2; reason: x", env.now),
	}
	env.knights["kay"] = map[string]interface{}{"replicas": int64(3), "readyReplicas": int64(1)}
	info.NumPending = 4
	env.tick(s)
	env.tick(s) // same events listed again must not duplicate

	h := s.history("kay", 0)
	if len(h.Samples) != 4 {
		t.Fatalf("want 4 samples, got %d", len(h.Samples))
	}
	if *h.Samples[1].Pending != 8 || h.Samples[1].Replicas != 1 || *h.Samples[2].Pending != 4 || h.Samples[2].Replicas != 3 {
		t.Fatalf("unexpected samples %+v", h.Samples)
	}
	if len(h.Events) != 1 {
		t.Fatalf("want exactly one scale event (no sampler duplicate), got %+v", h.Events)
	}
	e := h.Events[0]
	if e.Direction != "up" || e.To != 3 || e.From == nil || *e.From != 1 || e.Source != "hpa" ||
		e.Reason != reason || e.K8sReason != "SuccessfulRescale" || e.Object != "HorizontalPodAutoscaler/keda-hpa-kay" {
		t.Fatalf("unexpected event %+v", e)
	}
	if got := s.knightNames(); len(got) != 1 || got[0] != "kay" {
		t.Fatalf("knights = %v, want [kay]", got)
	}
}

func TestQueueSamplerKEDAScaledObjectEvents(t *testing.T) {
	env, s := newFakeQueueEnv(t)
	env.knights["kay"] = map[string]interface{}{"replicas": int64(0)}
	env.tick(s)
	env.events = []corev1.Event{{
		ObjectMeta:     metav1.ObjectMeta{UID: "a1"},
		InvolvedObject: corev1.ObjectReference{Kind: "ScaledObject", Name: "kay"},
		Reason:         "KEDAScaleTargetActivated",
		Message:        "Scaled apps/v1.Deployment roundtable/kay from 0 to 1, triggered by natsJetStreamScaler",
		LastTimestamp:  metav1.NewTime(env.now),
	}}
	env.knights["kay"] = map[string]interface{}{"replicas": int64(1)}
	env.tick(s)

	evs := s.history("kay", 0).Events
	if len(evs) != 1 || evs[0].Source != "keda" || evs[0].Direction != "up" || *evs[0].From != 0 || evs[0].To != 1 ||
		evs[0].Reason != "activated, triggered by natsJetStreamScaler" {
		t.Fatalf("unexpected events %+v", evs)
	}
}

func TestQueueSamplerObservedScaleWithoutEvent(t *testing.T) {
	env, s := newFakeQueueEnv(t)
	s.listEvents = nil // no RBAC for events
	env.knights["kay"] = map[string]interface{}{"replicas": int64(2)}
	env.tick(s)
	env.knights["kay"] = map[string]interface{}{"replicas": int64(1)}
	env.tick(s)

	evs := s.history("kay", 0).Events
	if len(evs) != 1 || evs[0].Source != "sample" || evs[0].Direction != "down" || *evs[0].From != 2 || evs[0].To != 1 {
		t.Fatalf("unexpected events %+v", evs)
	}
}

func TestQueueSamplerRetentionAndSince(t *testing.T) {
	env, s := newFakeQueueEnv(t)
	env.knights["kay"] = map[string]interface{}{"replicas": int64(1)}
	n := s.capacity() + 10
	for i := 0; i < n; i++ {
		env.tick(s)
	}
	h := s.history("kay", 0)
	if len(h.Samples) != s.capacity() {
		t.Fatalf("want %d samples after wrap, got %d", s.capacity(), len(h.Samples))
	}
	if span := h.Samples[len(h.Samples)-1].Time.Sub(h.Samples[0].Time); span > queueHistoryRetention {
		t.Fatalf("history spans %s, more than retention", span)
	}
	if got := len(s.history("kay", time.Minute).Samples); got != 4 {
		t.Fatalf("since=1m: want 4 samples, got %d", got)
	}

	// A knight gone for a whole retention window is forgotten
	delete(env.knights, "kay")
	env.knights["kay2"] = map[string]interface{}{}
	env.now = env.now.Add(queueHistoryRetention + time.Minute)
	env.tick(s)
	if names := s.knightNames(); len(names) != 1 || names[0] != "kay2" {
		t.Fatalf("knights = %v, want [kay2]", names)
	}
}

func TestQueueSamplerListKnightsError(t *testing.T) {
	_, s := newFakeQueueEnv(t)
	s.listKnights = func(context.Context) ([]unstructured.Unstructured, error) { return nil, errors.New("boom") }
	s.sampleOnce(context.Background())
	if len(s.knightNames()) != 0 {
		t.Fatal("no history expected when the knight list fails")
	}
}

func TestQueueHistoryHandlers(t *testing.T) {
	env, s := newFakeQueueEnv(t)
	env.knights["kay"] = map[string]interface{}{"replicas": int64(1)}
	env.consumers["fleet_a_tasks/Kay-consumer"] = &jetstream.ConsumerInfo{NumPending: 5}
	env.tick(s)
	t.Setenv("GRAFANA_QUEUE_URL", "https://grafana.example/d/q?var-knight={knight}")

	r := mux.NewRouter()
	r.HandleFunc("/api/fleet/{knight}/queue/history", knightQueueHistoryHandler(s))
	r.HandleFunc("/api/queues/history", queuesHistoryHandler(s))
	nilR := mux.NewRouter()
	nilR.HandleFunc("/api/fleet/{knight}/queue/history", knightQueueHistoryHandler(nil))
	nilR.HandleFunc("/api/queues/history", queuesHistoryHandler(nil))

	cases := []struct {
		router *mux.Router
		path   string
		code   int
	}{
		{r, "/api/fleet/kay/queue/history", http.StatusOK},
		{r, "/api/fleet/unknown/queue/history", http.StatusOK},
		{r, "/api/fleet/-bad/queue/history", http.StatusBadRequest},
		{r, "/api/fleet/kay/queue/history?since=nope", http.StatusBadRequest},
		{r, "/api/queues/history?since=-1h", http.StatusBadRequest},
		{r, "/api/queues/history?since=1h", http.StatusOK},
		{nilR, "/api/fleet/kay/queue/history", http.StatusServiceUnavailable},
		{nilR, "/api/queues/history", http.StatusServiceUnavailable},
	}
	for _, c := range cases {
		w := httptest.NewRecorder()
		c.router.ServeHTTP(w, httptest.NewRequest("GET", c.path, nil))
		if w.Code != c.code {
			t.Errorf("%s: code %d, want %d", c.path, w.Code, c.code)
		}
	}

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/fleet/kay/queue/history", nil))
	var h knightQueueHistory
	if err := json.Unmarshal(w.Body.Bytes(), &h); err != nil {
		t.Fatal(err)
	}
	if h.Knight != "kay" || len(h.Samples) != 1 || *h.Samples[0].Pending != 5 ||
		h.GrafanaURL != "https://grafana.example/d/q?var-knight=kay" {
		t.Fatalf("unexpected body %s", w.Body.String())
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/fleet/unknown/queue/history", nil))
	var empty map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &empty); err != nil ||
		string(empty["samples"]) != "[]" || string(empty["events"]) != "[]" {
		t.Fatalf("unknown knight should return empty arrays, got %s", w.Body.String())
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/queues/history", nil))
	var all []knightQueueHistory
	if err := json.Unmarshal(w.Body.Bytes(), &all); err != nil || len(all) != 1 || all[0].Knight != "kay" {
		t.Fatalf("unexpected /api/queues/history body %s", w.Body.String())
	}
}

// pagingEvents serves n events of one kind through the Events list contract:
// Limit is the page size and Continue carries the offset of the next page.
func pagingEvents(t *testing.T, n int, calls *[]metav1.ListOptions) func(context.Context, metav1.ListOptions) (*corev1.EventList, error) {
	return func(_ context.Context, opts metav1.ListOptions) (*corev1.EventList, error) {
		*calls = append(*calls, opts)
		kind := strings.TrimPrefix(opts.FieldSelector, "involvedObject.kind=")
		if kind != "HorizontalPodAutoscaler" {
			return &corev1.EventList{}, nil
		}
		start := 0
		if opts.Continue != "" {
			v, err := strconv.Atoi(opts.Continue)
			if err != nil {
				t.Fatalf("bad continue token %q", opts.Continue)
			}
			start = v
		}
		end := min(n, start+int(opts.Limit))
		list := &corev1.EventList{}
		for i := start; i < end; i++ {
			list.Items = append(list.Items, corev1.Event{ObjectMeta: metav1.ObjectMeta{Name: strconv.Itoa(i)}})
		}
		if end < n {
			list.Continue = strconv.Itoa(end)
		}
		return list, nil
	}
}

func TestListScaleEventsFollowsContinue(t *testing.T) {
	var calls []metav1.ListOptions
	items, err := listScaleEvents(context.Background(), pagingEvents(t, 1200, &calls))
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1200 {
		t.Fatalf("read %d events, want 1200", len(items))
	}
	// 1200 HPA events take three pages of 500; ScaledObject is one empty page.
	if len(calls) != 4 {
		t.Fatalf("list calls = %d, want 4", len(calls))
	}
	if calls[1].Continue != "500" || calls[2].Continue != "1000" {
		t.Errorf("continue tokens = %q, %q", calls[1].Continue, calls[2].Continue)
	}
	for _, c := range calls {
		if c.Limit != scaleEventLimit {
			t.Errorf("page size = %d, want %d", c.Limit, scaleEventLimit)
		}
	}
}

func TestListScaleEventsPageBound(t *testing.T) {
	var calls []metav1.ListOptions
	items, err := listScaleEvents(context.Background(), pagingEvents(t, 10000, &calls))
	if err != nil {
		t.Fatal(err)
	}
	if want := scaleEventMaxPages * scaleEventLimit; len(items) != want {
		t.Fatalf("read %d events, want the bound of %d", len(items), want)
	}
	if hpa := len(calls) - 1; hpa != scaleEventMaxPages {
		t.Fatalf("HPA pages = %d, want %d", hpa, scaleEventMaxPages)
	}
}
