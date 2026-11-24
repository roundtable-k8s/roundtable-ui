package main

// Queue history sampler (#205, part of #185).
//
// Every queueSampleInterval the API samples, for each Knight CR, its durable
// JetStream consumer (pending, ack-pending, redelivered, waiting pulls) and
// its replica counts, into a per-knight in-memory ring buffer that covers
// queueHistoryRetention. In the same tick it reads the namespace's Kubernetes
// events and keeps the scale transitions emitted by KEDA (ScaledObject) and
// by KEDA's generated HPA ("keda-hpa-<knight>"), with their reasons. A replica
// change seen between two samples that no Kubernetes event explains (no RBAC
// for events, manual scaling, or a missed event) is recorded as a scale event
// with source "sample", so every transition shows up in the history.
//
// The buffer is in memory only and resets when the API restarts; long-term
// history belongs in Grafana (roundtable-k8s/roundtable#158). When
// GRAFANA_QUEUE_URL is set, the history responses carry that link (with
// "{knight}" replaced by the knight name) so the panel can point there.

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/nats-io/nats.go/jetstream"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

const (
	queueSampleInterval   = 15 * time.Second
	queueHistoryRetention = 6 * time.Hour
	kedaHPAPrefix         = "keda-hpa-" // KEDA names its HPA keda-hpa-<ScaledObject>
	queueSampleTimeout    = 5 * time.Second
)

// queueSample is one point of a knight's queue/replica history. Queue fields
// are null when the consumer could not be read in that tick, so a chart shows
// a gap instead of a false zero.
type queueSample struct {
	Time            time.Time `json:"t"`
	Pending         *uint64   `json:"pending"`
	AckPending      *int      `json:"ackPending"`
	Redelivered     *int      `json:"redelivered"`
	Waiting         *int      `json:"waiting"`
	Replicas        int       `json:"replicas"`
	ReadyReplicas   int       `json:"readyReplicas"`
	DesiredReplicas *int      `json:"desiredReplicas,omitempty"`
	MaxReplicas     *int      `json:"maxReplicas,omitempty"`
}

// scaleEvent is a replica transition for a knight.
type scaleEvent struct {
	Time      time.Time `json:"t"`
	Direction string    `json:"direction"` // "up" or "down"
	From      *int      `json:"from,omitempty"`
	To        int       `json:"to"`
	Reason    string    `json:"reason"`              // human-readable cause
	K8sReason string    `json:"k8sReason,omitempty"` // e.g. SuccessfulRescale
	Source    string    `json:"source"`              // "hpa", "keda" or "sample"
	Object    string    `json:"object,omitempty"`    // Kind/name the event was about
}

// ring is a fixed-capacity FIFO that overwrites its oldest entry when full.
type ring[T any] struct {
	buf  []T
	head int // index of the oldest entry
	n    int
}

func newRing[T any](capacity int) *ring[T] {
	if capacity < 1 {
		capacity = 1
	}
	return &ring[T]{buf: make([]T, capacity)}
}

func (r *ring[T]) push(v T) {
	if r.n < len(r.buf) {
		r.buf[(r.head+r.n)%len(r.buf)] = v
		r.n++
		return
	}
	r.buf[r.head] = v
	r.head = (r.head + 1) % len(r.buf)
}

// items returns the entries oldest first.
func (r *ring[T]) items() []T {
	out := make([]T, r.n)
	for i := 0; i < r.n; i++ {
		out[i] = r.buf[(r.head+i)%len(r.buf)]
	}
	return out
}

func (r *ring[T]) last() (T, bool) {
	var zero T
	if r.n == 0 {
		return zero, false
	}
	return r.buf[(r.head+r.n-1)%len(r.buf)], true
}

type knightHistory struct {
	samples  *ring[queueSample]
	events   *ring[scaleEvent]
	lastSeen time.Time
}

// queueSampler owns the history buffers. Its data sources are functions so
// tests can swap in fakes for JetStream and Kubernetes.
type queueSampler struct {
	interval  time.Duration
	retention time.Duration
	now       func() time.Time

	listKnights  func(ctx context.Context) ([]unstructured.Unstructured, error)
	consumerInfo func(ctx context.Context, stream, consumer string) (*jetstream.ConsumerInfo, error)
	listEvents   func(ctx context.Context) ([]corev1.Event, error) // nil: no scale events from k8s

	mu       sync.RWMutex
	knights  map[string]*knightHistory
	seenEvts map[string]time.Time // event UID/count -> event time, for dedupe
}

func newQueueSampler(interval, retention time.Duration) *queueSampler {
	return &queueSampler{
		interval:  interval,
		retention: retention,
		now:       time.Now,
		knights:   map[string]*knightHistory{},
		seenEvts:  map[string]time.Time{},
	}
}

// newClusterQueueSampler wires the sampler to the API's JetStream and
// Kubernetes clients.
func newClusterQueueSampler(namespace string) *queueSampler {
	s := newQueueSampler(queueSampleInterval, queueHistoryRetention)
	s.listKnights = func(ctx context.Context) ([]unstructured.Unstructured, error) {
		if dynClient == nil {
			return nil, errors.New("kubernetes not available")
		}
		list, err := dynClient.Resource(knightGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, err
		}
		return list.Items, nil
	}
	s.consumerInfo = func(ctx context.Context, stream, consumer string) (*jetstream.ConsumerInfo, error) {
		if js == nil {
			return nil, errors.New("jetstream not available")
		}
		c, err := js.Consumer(ctx, stream, consumer)
		if err != nil {
			return nil, err
		}
		return c.CachedInfo(), nil // Consumer() just fetched it
	}
	if k8sClient != nil {
		s.listEvents = func(ctx context.Context) ([]corev1.Event, error) {
			list, err := k8sClient.CoreV1().Events(namespace).List(ctx, metav1.ListOptions{})
			if err != nil {
				return nil, err
			}
			return list.Items, nil
		}
	}
	return s
}

func (s *queueSampler) capacity() int {
	if s.interval <= 0 {
		return 1
	}
	return int(s.retention / s.interval)
}

// run samples immediately and then every interval until ctx is done.
func (s *queueSampler) run(ctx context.Context) {
	s.sampleOnce(ctx)
	t := time.NewTicker(s.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.sampleOnce(ctx)
		}
	}
}

// knightQueueTarget is what the sampler needs from a Knight CR.
type knightQueueTarget struct {
	name, stream, consumer string
	replicas, ready        int
	desired, max           *int
}

func knightTarget(cr *unstructured.Unstructured) knightQueueTarget {
	spec := getNestedMap(cr.Object, "spec")
	status := getNestedMap(cr.Object, "status")
	t := knightQueueTarget{
		name:     cr.GetName(),
		stream:   getStr(getNestedMap(spec, "nats"), "stream"),
		consumer: getStr(status, "natsConsumer"),
		replicas: getInt(status, "replicas"),
		ready:    getInt(status, "readyReplicas"),
	}
	if t.stream == "" {
		t.stream = defaultTasksStream
	}
	if t.consumer == "" {
		// Runtimes create "${KNIGHT_NAME}-consumer" with the capitalised name
		t.consumer = capitalizeKnight(t.name) + "-consumer"
	}
	// status.scaling (roundtable#250) when present, else the spec bound
	scaling := getNestedMap(status, "scaling")
	if _, ok := scaling["desiredReplicas"]; ok {
		v := getInt(scaling, "desiredReplicas")
		t.desired = &v
	}
	if _, ok := scaling["maxReplicas"]; ok {
		v := getInt(scaling, "maxReplicas")
		t.max = &v
	} else if _, ok := spec["maxReplicas"]; ok {
		v := getInt(spec, "maxReplicas")
		t.max = &v
	}
	return t
}

// sampleOnce takes one sample of every knight and ingests new scale events.
func (s *queueSampler) sampleOnce(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, queueSampleTimeout)
	defer cancel()

	crs, err := s.listKnights(ctx)
	if err != nil {
		slog.Warn("queue sampler: list knights failed", "error", err)
		return
	}
	now := s.now()

	samples := make(map[string]queueSample, len(crs))
	for i := range crs {
		t := knightTarget(&crs[i])
		smp := queueSample{
			Time: now, Replicas: t.replicas, ReadyReplicas: t.ready,
			DesiredReplicas: t.desired, MaxReplicas: t.max,
		}
		if info, cerr := s.consumerInfo(ctx, t.stream, t.consumer); cerr != nil {
			slog.Debug("queue sampler: consumer info failed", "knight", t.name, "consumer", t.consumer, "error", cerr)
		} else if info != nil {
			pending, ack, redeliv, waiting := info.NumPending, info.NumAckPending, info.NumRedelivered, info.NumWaiting
			smp.Pending, smp.AckPending, smp.Redelivered, smp.Waiting = &pending, &ack, &redeliv, &waiting
		}
		samples[t.name] = smp
	}

	var evts []corev1.Event
	if s.listEvents != nil {
		if evts, err = s.listEvents(ctx); err != nil {
			slog.Debug("queue sampler: list events failed", "error", err)
			evts = nil
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.ingestEventsLocked(evts, samples)
	for name, smp := range samples {
		h := s.historyLocked(name)
		if prev, ok := h.samples.last(); ok && prev.Replicas != smp.Replicas && !s.explainedLocked(h, prev, smp) {
			from := prev.Replicas
			h.events.push(scaleEvent{
				Time: smp.Time, Direction: direction(from, smp.Replicas), From: &from, To: smp.Replicas,
				Reason: "replica count changed (observed by sampler)", Source: "sample",
			})
		}
		h.samples.push(smp)
		h.lastSeen = now
	}
	s.pruneLocked(now)
}

func (s *queueSampler) historyLocked(name string) *knightHistory {
	h, ok := s.knights[name]
	if !ok {
		c := s.capacity()
		h = &knightHistory{samples: newRing[queueSample](c), events: newRing[scaleEvent](c)}
		s.knights[name] = h
	}
	return h
}

// explainedLocked reports whether a k8s scale event to the new replica count
// was recorded since shortly before the previous sample.
func (s *queueSampler) explainedLocked(h *knightHistory, prev, cur queueSample) bool {
	since := prev.Time.Add(-s.interval)
	for _, e := range h.events.items() {
		if e.Source != "sample" && e.To == cur.Replicas && !e.Time.Before(since) {
			return true
		}
	}
	return false
}

// pruneLocked drops knights not seen for a whole retention window and
// forgets dedupe keys of events older than it.
func (s *queueSampler) pruneLocked(now time.Time) {
	cutoff := now.Add(-s.retention)
	for name, h := range s.knights {
		if h.lastSeen.Before(cutoff) {
			delete(s.knights, name)
		}
	}
	for k, t := range s.seenEvts {
		if t.Before(cutoff) {
			delete(s.seenEvts, k)
		}
	}
}

var (
	hpaNewSizeRe  = regexp.MustCompile(`New size: (\d+)(?:; reason: (.*))?`)
	kedaScaledRe  = regexp.MustCompile(`from (\d+) to (\d+)`)
	kedaTriggerRe = regexp.MustCompile(`triggered by (.+)$`)
)

func direction(from, to int) string {
	if to < from {
		return "down"
	}
	return "up"
}

func eventTime(e *corev1.Event) time.Time {
	switch {
	case !e.LastTimestamp.IsZero():
		return e.LastTimestamp.Time
	case !e.EventTime.IsZero():
		return e.EventTime.Time
	case !e.FirstTimestamp.IsZero():
		return e.FirstTimestamp.Time
	}
	return e.CreationTimestamp.Time
}

// parseScaleEvent turns a KEDA/HPA event into a scaleEvent for a knight.
// ok is false for events that are not replica transitions of a knight.
func parseScaleEvent(e *corev1.Event) (knight string, ev scaleEvent, ok bool) {
	obj := e.InvolvedObject
	ev = scaleEvent{Time: eventTime(e), K8sReason: e.Reason, Object: obj.Kind + "/" + obj.Name}
	switch obj.Kind {
	case "HorizontalPodAutoscaler":
		if e.Reason != "SuccessfulRescale" || !strings.HasPrefix(obj.Name, kedaHPAPrefix) {
			return "", ev, false
		}
		m := hpaNewSizeRe.FindStringSubmatch(e.Message)
		if m == nil {
			return "", ev, false
		}
		ev.To, _ = strconv.Atoi(m[1])
		ev.Reason = strings.TrimSpace(m[2])
		if ev.Reason == "" {
			ev.Reason = e.Message
		}
		ev.Source = "hpa"
		return strings.TrimPrefix(obj.Name, kedaHPAPrefix), ev, true
	case "ScaledObject":
		// KEDAScaleTargetActivated / KEDAScaleTargetDeactivated:
		// "Scaled apps/v1.Deployment ns/name from 0 to 1, triggered by natsJetStreamScaler"
		m := kedaScaledRe.FindStringSubmatch(e.Message)
		if m == nil {
			return "", ev, false
		}
		from, _ := strconv.Atoi(m[1])
		ev.From = &from
		ev.To, _ = strconv.Atoi(m[2])
		ev.Direction = direction(from, ev.To)
		switch {
		case e.Reason == "KEDAScaleTargetDeactivated":
			ev.Reason = "no pending tasks: scaled to zero"
		case kedaTriggerRe.MatchString(e.Message):
			ev.Reason = "activated, " + kedaTriggerRe.FindStringSubmatch(e.Message)[0]
		default:
			ev.Reason = e.Message
		}
		ev.Source = "keda"
		return obj.Name, ev, true
	}
	return "", ev, false
}

// ingestEventsLocked records scale events not seen before, for known knights.
func (s *queueSampler) ingestEventsLocked(evts []corev1.Event, samples map[string]queueSample) {
	cutoff := s.now().Add(-s.retention)
	sort.SliceStable(evts, func(i, j int) bool { return eventTime(&evts[i]).Before(eventTime(&evts[j])) })
	for i := range evts {
		e := &evts[i]
		knight, ev, ok := parseScaleEvent(e)
		if !ok || ev.Time.Before(cutoff) {
			continue
		}
		if _, known := samples[knight]; !known {
			if _, had := s.knights[knight]; !had {
				continue
			}
		}
		key := string(e.UID) + "/" + strconv.Itoa(int(e.Count)) + "/" + ev.Time.Format(time.RFC3339Nano)
		if _, dup := s.seenEvts[key]; dup {
			continue
		}
		s.seenEvts[key] = ev.Time
		h := s.historyLocked(knight)
		if ev.From == nil {
			if prev, ok := h.samples.last(); ok {
				from := prev.Replicas
				ev.From = &from
			}
		}
		if ev.Direction == "" {
			if ev.From != nil {
				ev.Direction = direction(*ev.From, ev.To)
			} else {
				ev.Direction = "up"
			}
		}
		h.events.push(ev)
	}
}

// knightQueueHistory is the API view of one knight's history.
type knightQueueHistory struct {
	Knight           string        `json:"knight"`
	IntervalSeconds  int           `json:"intervalSeconds"`
	RetentionSeconds int           `json:"retentionSeconds"`
	Samples          []queueSample `json:"samples"`
	Events           []scaleEvent  `json:"events"`
	GrafanaURL       string        `json:"grafanaUrl,omitempty"`
}

// history returns a knight's samples and events newer than since (zero:
// whole retention window), oldest first.
func (s *queueSampler) history(name string, since time.Duration) knightQueueHistory {
	out := knightQueueHistory{
		Knight:           name,
		IntervalSeconds:  int(s.interval / time.Second),
		RetentionSeconds: int(s.retention / time.Second),
		Samples:          []queueSample{},
		Events:           []scaleEvent{},
		GrafanaURL:       grafanaQueueURL(name),
	}
	window := s.retention
	if since > 0 && since < window {
		window = since
	}
	cutoff := s.now().Add(-window)

	s.mu.RLock()
	defer s.mu.RUnlock()
	h, ok := s.knights[name]
	if !ok {
		return out
	}
	for _, smp := range h.samples.items() {
		if !smp.Time.Before(cutoff) {
			out.Samples = append(out.Samples, smp)
		}
	}
	for _, e := range h.events.items() {
		if !e.Time.Before(cutoff) {
			out.Events = append(out.Events, e)
		}
	}
	sort.SliceStable(out.Events, func(i, j int) bool { return out.Events[i].Time.Before(out.Events[j].Time) })
	return out
}

func (s *queueSampler) knightNames() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.knights))
	for n := range s.knights {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

func grafanaQueueURL(knight string) string {
	tmpl := envOr("GRAFANA_QUEUE_URL", "")
	if tmpl == "" {
		return ""
	}
	return strings.ReplaceAll(tmpl, "{knight}", url.QueryEscape(knight))
}

// parseSince reads the optional ?since= duration (e.g. 30m, 2h).
func parseSince(r *http.Request) (time.Duration, error) {
	v := r.URL.Query().Get("since")
	if v == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return 0, errors.New("invalid since duration")
	}
	return d, nil
}

// knightQueueHistoryHandler serves GET /api/fleet/{knight}/queue/history.
func knightQueueHistoryHandler(s *queueSampler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s == nil {
			http.Error(w, "Queue history not available", http.StatusServiceUnavailable)
			return
		}
		name := mux.Vars(r)["knight"]
		if !validKnightName.MatchString(name) {
			http.Error(w, "Invalid knight name", http.StatusBadRequest)
			return
		}
		since, err := parseSince(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.history(name, since))
	}
}

// queuesHistoryHandler serves GET /api/queues/history: every sampled knight.
func queuesHistoryHandler(s *queueSampler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s == nil {
			http.Error(w, "Queue history not available", http.StatusServiceUnavailable)
			return
		}
		since, err := parseSince(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		out := []knightQueueHistory{}
		for _, n := range s.knightNames() {
			out = append(out, s.history(n, since))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	}
}
