package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Multi-table support (#239). Each RoundTable carries its own NATS subject
// prefix and JetStream streams (spec.nats). The dashboard discovers them from
// the RoundTable resources instead of reading one FLEET_PREFIX/FLEET_STREAM
// pair, so task history, the live feed and dispatch cover every table.
//
// FLEET_PREFIX and FLEET_STREAM remain as an optional filter for single-table
// installs: with FLEET_PREFIX set only the table on that prefix is used (and
// FLEET_STREAM, when set, overrides its results stream). When no table can be
// discovered (no Kubernetes access, no RoundTables) the env pair — or the
// legacy fleet-a / fleet_a_results defaults — describes the only table.

const (
	legacyFleetPrefix = "fleet-a"
	legacyFleetStream = "fleet_a_results"
	tableCacheTTL     = 30 * time.Second
)

// validNATSPrefix guards prefixes read from RoundTable resources before they
// are used in subscriptions: dot-separated tokens, no wildcards or spaces.
var validNATSPrefix = regexp.MustCompile(`^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`)

// validStreamName matches JetStream stream names (no spaces, dots or wildcards).
var validStreamName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,255}$`)

// TableInfo is one RoundTable's NATS layout.
type TableInfo struct {
	Name          string `json:"name"`
	Prefix        string `json:"prefix"`
	TasksStream   string `json:"tasksStream,omitempty"`
	ResultsStream string `json:"resultsStream,omitempty"`
}

// tableSource discovers tables from RoundTable resources, applies the env
// filter and caches the result briefly.
type tableSource struct {
	namespace string
	envPrefix string // FLEET_PREFIX, "" when unset
	envStream string // FLEET_STREAM, "" when unset
	ttl       time.Duration
	now       func() time.Time

	mu      sync.Mutex
	cached  []TableInfo
	fetched time.Time
	ok      bool // cached came from a successful list

	inflight *tableFlight // non-nil while a discovery runs
}

// tableFlight marks one in-progress discovery; done closes when it finishes.
type tableFlight struct{ done chan struct{} }

func newTableSource(namespace, envPrefix, envStream string) *tableSource {
	return &tableSource{
		namespace: namespace,
		envPrefix: strings.TrimSpace(envPrefix),
		envStream: strings.TrimSpace(envStream),
		ttl:       tableCacheTTL,
		now:       time.Now,
	}
}

// newTableSourceFromEnv reads FLEET_PREFIX / FLEET_STREAM; unset or empty
// means "no filter".
func newTableSourceFromEnv(namespace string) *tableSource {
	return newTableSource(namespace, os.Getenv("FLEET_PREFIX"), os.Getenv("FLEET_STREAM"))
}

// defaultPrefix is the prefix used when no better one is known (e.g. the
// introspect fallback when a Knight CR cannot be read).
func (s *tableSource) defaultPrefix() string {
	if s.envPrefix != "" {
		return s.envPrefix
	}
	return legacyFleetPrefix
}

// tables returns the tables the dashboard covers, sorted by name. Never empty.
// The lock is not held while the RoundTable list runs: concurrent callers
// share one in-flight discovery, and a caller holding a cached copy (even a
// stale one) while a refresh is under way returns that copy immediately.
func (s *tableSource) tables(ctx context.Context) []TableInfo {
	s.mu.Lock()
	if s.ok && s.now().Sub(s.fetched) < s.ttl {
		out := append([]TableInfo(nil), s.cached...)
		s.mu.Unlock()
		return out
	}
	if f := s.inflight; f != nil {
		if s.ok {
			out := append([]TableInfo(nil), s.cached...)
			s.mu.Unlock()
			return out
		}
		s.mu.Unlock()
		select {
		case <-f.done:
		case <-ctx.Done():
		}
		return s.afterDiscovery()
	}
	f := &tableFlight{done: make(chan struct{})}
	s.inflight = f
	s.mu.Unlock()

	err := s.runFlight(ctx, f)
	if err != nil {
		slog.WarnContext(ctx, "Tables: RoundTable list failed", "error", err, "cached", s.hasCache())
	}
	return s.afterDiscovery()
}

// runFlight performs the shared discovery for flight f. It runs under its own
// context, bounded by k8sRequestTimeout, so one caller disconnecting does not
// fail the flight for every waiter. The flight is always released (even if
// discover panics) so waiters never block forever.
func (s *tableSource) runFlight(ctx context.Context, f *tableFlight) error {
	defer func() {
		s.mu.Lock()
		s.inflight = nil
		close(f.done)
		s.mu.Unlock()
	}()
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), k8sRequestTimeout)
	defer cancel()
	discovered, err := s.discover(dctx)
	if err == nil {
		s.mu.Lock()
		s.cached = resolveTables(discovered, s.envPrefix, s.envStream)
		s.fetched = s.now()
		s.ok = true
		s.mu.Unlock()
	}
	return err
}

func (s *tableSource) hasCache() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ok
}

// afterDiscovery returns the last good list, or the FLEET_PREFIX fallback
// when no list has ever succeeded.
func (s *tableSource) afterDiscovery() []TableInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ok {
		return append([]TableInfo(nil), s.cached...)
	}
	return resolveTables(nil, s.envPrefix, s.envStream)
}

// tablesHandler serves GET /api/tables: the covered tables, without touching
// NATS.
func tablesHandler(src *tableSource) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"tables": src.tables(r.Context())})
	}
}

// prefixes returns the distinct NATS prefixes of all tables.
func (s *tableSource) prefixes(ctx context.Context) []string {
	var out []string
	for _, t := range s.tables(ctx) {
		out = append(out, t.Prefix)
	}
	return out
}

func (s *tableSource) discover(ctx context.Context) ([]TableInfo, error) {
	if dynClient == nil {
		return nil, fmt.Errorf("kubernetes client not available")
	}
	list, err := dynClient.Resource(roundTableGVR).Namespace(s.namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]TableInfo, 0, len(list.Items))
	for i := range list.Items {
		if t, ok := tableFromRoundTable(ctx, &list.Items[i]); ok {
			out = append(out, t)
		}
	}
	return out, nil
}

// tableFromRoundTable reads spec.nats from a RoundTable. Tables without a
// usable prefix are skipped; invalid stream names are dropped.
func tableFromRoundTable(ctx context.Context, obj *unstructured.Unstructured) (TableInfo, bool) {
	n := getNestedMap(getNestedMap(obj.Object, "spec"), "nats")
	t := TableInfo{
		Name:          obj.GetName(),
		Prefix:        getStr(n, "subjectPrefix"),
		TasksStream:   getStr(n, "tasksStream"),
		ResultsStream: getStr(n, "resultsStream"),
	}
	if t.Name == "" || !validNATSPrefix.MatchString(t.Prefix) {
		if t.Name != "" {
			slog.WarnContext(ctx, "Tables: skipping RoundTable with invalid subjectPrefix", "table", t.Name, "prefix", t.Prefix)
		}
		return TableInfo{}, false
	}
	if !validStreamName.MatchString(t.TasksStream) {
		t.TasksStream = ""
	}
	if !validStreamName.MatchString(t.ResultsStream) {
		t.ResultsStream = ""
	}
	return t, true
}

// resolveTables applies the FLEET_PREFIX / FLEET_STREAM filter to the
// discovered tables. Two tables sharing a prefix collapse into the first by
// name (they share subjects, so listing both would double every event).
func resolveTables(discovered []TableInfo, envPrefix, envStream string) []TableInfo {
	sorted := append([]TableInfo(nil), discovered...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })

	seen := map[string]bool{}
	var out []TableInfo
	for _, t := range sorted {
		if envPrefix != "" && t.Prefix != envPrefix {
			continue
		}
		if seen[t.Prefix] {
			continue
		}
		seen[t.Prefix] = true
		if envPrefix != "" && envStream != "" {
			t.ResultsStream = envStream
		}
		out = append(out, t)
	}
	if len(out) > 0 {
		return out
	}

	// Nothing discovered (or nothing on FLEET_PREFIX): the env pair, or the
	// legacy defaults, describe the only table — the pre-#239 behaviour.
	prefix, stream := envPrefix, envStream
	if prefix == "" {
		prefix = legacyFleetPrefix
	}
	if stream == "" {
		stream = legacyFleetStream
	}
	return []TableInfo{{Name: prefix, Prefix: prefix, ResultsStream: stream}}
}

func findTableByName(tables []TableInfo, name string) (TableInfo, bool) {
	for _, t := range tables {
		if t.Name == name {
			return t, true
		}
	}
	return TableInfo{}, false
}

func findTableByPrefix(tables []TableInfo, prefix string) (TableInfo, bool) {
	for _, t := range tables {
		if t.Prefix == prefix {
			return t, true
		}
	}
	return TableInfo{}, false
}

// tableForSubject returns the table whose prefix owns subject (longest
// prefix wins, so "a" and "a.b" can coexist).
func tableForSubject(tables []TableInfo, subject string) (TableInfo, bool) {
	best, found := TableInfo{}, false
	for _, t := range tables {
		if strings.HasPrefix(subject, t.Prefix+".") && (!found || len(t.Prefix) > len(best.Prefix)) {
			best, found = t, true
		}
	}
	return best, found
}

// --- task history reading ---

// resultsReader reads up to limit of the newest messages on filter from a
// JetStream stream, plus the stream's total message count. A variable so
// tests can stand in for JetStream.
type resultsReader func(ctx context.Context, stream, filter string, limit int) ([]TaskEvent, uint64, error)

var readResults resultsReader = jsReadResults

func jsReadResults(ctx context.Context, streamName, filter string, limit int) ([]TaskEvent, uint64, error) {
	if js == nil {
		return nil, 0, fmt.Errorf("JetStream not available")
	}
	stream, err := js.Stream(ctx, streamName)
	if err != nil {
		return nil, 0, err
	}
	info, err := stream.Info(ctx)
	if err != nil {
		return nil, 0, err
	}
	// Result subjects are unique per task, so start limit messages back from
	// the stream tail and read forward.
	startSeq := uint64(1)
	if info.State.LastSeq > uint64(limit) {
		startSeq = info.State.LastSeq - uint64(limit) + 1
	}
	// Ephemeral consumer with InactiveThreshold for auto-cleanup (#54)
	cons, err := stream.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		DeliverPolicy:     jetstream.DeliverByStartSequencePolicy,
		OptStartSeq:       startSeq,
		FilterSubject:     filter,
		AckPolicy:         jetstream.AckNonePolicy,
		InactiveThreshold: 30 * time.Second,
	})
	if err != nil {
		// Stream info only, as before.
		return nil, info.State.Msgs, nil
	}
	var events []TaskEvent
	if msgs, _ := cons.FetchNoWait(limit); msgs != nil {
		for msg := range msgs.Messages() {
			events = append(events, TaskEvent{
				Type:      "result",
				Subject:   msg.Subject(),
				Data:      msg.Data(),
				Timestamp: eventTimestamp(msg.Data()),
			})
		}
	}
	return events, info.State.Msgs, nil
}

var errNATSUnavailable = errors.New("NATS not available")

// tableNone is the table value reported for objects without a RoundTable.
const tableNone = "none"

// tableOrNone returns name, or "none" when it is empty.
func tableOrNone(name string) string {
	if name == "" {
		return tableNone
	}
	return name
}

// tableFilter returns the ?table= query value ("" means no filtering). An
// unknown table matches nothing, so list endpoints return an empty list.
func tableFilter(r *http.Request) string {
	return r.URL.Query().Get("table")
}

// tableMatches reports whether an object on table have passes the filter.
func tableMatches(filter, have string) bool {
	return filter == "" || filter == tableOrNone(have)
}
