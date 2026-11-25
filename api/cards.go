package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// Agent cards (#251). The RoundTable controller keeps one card per knight in
// a NATS KV bucket (key <table>.<knight>, schema in roundtable
// docs/agent-cards.md). Running knight pods register as the NATS micro
// service "roundtable-knight"; its STATS replies say which knights are live
// and how busy they are. The dashboard only reads both: it never creates the
// bucket, so a missing bucket simply means no cards.

const (
	defaultCardsBucket = "roundtable-cards"
	knightServiceName  = "roundtable-knight"
	cardStatsWait      = 500 * time.Millisecond
	cardStatsTTL       = 10 * time.Second
	cardListTimeout    = 5 * time.Second
)

// CardEntry is one knight's card as served by /api/cards and pushed as a
// "cards" WS event.
type CardEntry struct {
	Table  string          `json:"table"`
	Knight string          `json:"knight"`
	Card   json.RawMessage `json:"card"`
	Live   bool            `json:"live"`
	Stats  json.RawMessage `json:"stats"` // latest STATS reply, null when not live
}

// cardDeleted is the WS payload for a card that was removed.
type cardDeleted struct {
	Table   string `json:"table"`
	Knight  string `json:"knight"`
	Deleted bool   `json:"deleted"`
}

// cardStore reads cards from KV, joins knight STATS onto them and fans KV
// changes out to WS subscribers.
type cardStore struct {
	nc     *nats.Conn
	js     jetstream.JetStream
	bucket string
	tables func(ctx context.Context) []TableInfo

	statsWait time.Duration
	statsTTL  time.Duration
	backoff   time.Duration
	now       func() time.Time

	statsMu sync.Mutex
	statsAt time.Time
	stats   map[string]json.RawMessage // cardStatsKey → STATS reply
	cached  bool

	subMu   sync.Mutex
	subs    map[int]func([]byte)
	nextSub int
}

func newCardStore(nc *nats.Conn, js jetstream.JetStream, bucket string, tables func(ctx context.Context) []TableInfo) *cardStore {
	if bucket == "" {
		bucket = defaultCardsBucket
	}
	return &cardStore{
		nc:        nc,
		js:        js,
		bucket:    bucket,
		tables:    tables,
		statsWait: cardStatsWait,
		statsTTL:  cardStatsTTL,
		backoff:   5 * time.Second,
		now:       time.Now,
		subs:      map[int]func([]byte){},
	}
}

// cardStatsKey matches STATS replies to cards: exact table, knight
// case-insensitive (as the controller matches INFO replies).
func cardStatsKey(table, knight string) string {
	return table + "\x00" + strings.ToLower(knight)
}

// validCardToken is one KV key token: no dots, wildcards or spaces.
var validCardToken = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// cardTables returns the configured tables whose names are usable as a KV key
// token (no dots, wildcards or spaces).
func cardTables(tables []TableInfo) []TableInfo {
	var out []TableInfo
	for _, t := range tables {
		if validCardToken.MatchString(t.Name) {
			out = append(out, t)
		}
	}
	return out
}

// splitCardKey splits <table>.<knight> for one of the tables.
func splitCardKey(key string, tables []TableInfo) (string, string, bool) {
	for _, t := range tables {
		if knight, ok := strings.CutPrefix(key, t.Name+"."); ok && knight != "" && !strings.Contains(knight, ".") {
			return t.Name, knight, true
		}
	}
	return "", "", false
}

// keyValue opens the cards bucket without creating it. ok=false (and a nil
// error) means the bucket does not exist.
func (c *cardStore) keyValue(ctx context.Context) (jetstream.KeyValue, bool, error) {
	if c.js == nil {
		return nil, false, errNATSUnavailable
	}
	kv, err := c.js.KeyValue(ctx, c.bucket)
	if errors.Is(err, jetstream.ErrBucketNotFound) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return kv, true, nil
}

// list returns every card of the tables, sorted by table and knight.
func (c *cardStore) list(ctx context.Context, tables []TableInfo) ([]CardEntry, error) {
	out := []CardEntry{}
	tables = cardTables(tables)
	if len(tables) == 0 {
		return out, nil
	}
	kv, ok, err := c.keyValue(ctx)
	if err != nil || !ok {
		return out, err
	}
	filters := make([]string, 0, len(tables))
	for _, t := range tables {
		filters = append(filters, t.Name+".*")
	}
	w, err := kv.WatchFiltered(ctx, filters, jetstream.IgnoreDeletes())
	if err != nil {
		return nil, err
	}
	defer w.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case e, open := <-w.Updates():
			if !open {
				return nil, errors.New("cards watch closed")
			}
			if e == nil { // initial values delivered
				stats := c.liveStats(ctx)
				for i := range out {
					c.join(&out[i], stats)
				}
				sort.Slice(out, func(i, j int) bool {
					if out[i].Table != out[j].Table {
						return out[i].Table < out[j].Table
					}
					return out[i].Knight < out[j].Knight
				})
				return out, nil
			}
			table, knight, ok := splitCardKey(e.Key(), tables)
			if !ok || !json.Valid(e.Value()) {
				continue
			}
			out = append(out, CardEntry{Table: table, Knight: knight, Card: json.RawMessage(e.Value())})
		}
	}
}

func (c *cardStore) join(e *CardEntry, stats map[string]json.RawMessage) {
	if s, ok := stats[cardStatsKey(e.Table, e.Knight)]; ok {
		e.Live, e.Stats = true, s
	} else {
		e.Live, e.Stats = false, nil
	}
}

// liveStats returns the STATS replies of all running knights, cached for
// statsTTL. A failed request is cached too (as "nobody live") so a NATS
// problem costs at most one statsWait per TTL.
func (c *cardStore) liveStats(ctx context.Context) map[string]json.RawMessage {
	c.statsMu.Lock()
	defer c.statsMu.Unlock()
	if c.cached && c.now().Sub(c.statsAt) < c.statsTTL {
		return c.stats
	}
	stats, err := c.requestStats(ctx)
	if err != nil {
		slog.Warn("Cards: knight STATS request failed", "error", err)
	}
	c.stats, c.statsAt, c.cached = stats, c.now(), true
	return stats
}

// requestStats sends $SRV.STATS.roundtable-knight and collects every reply
// for statsWait. Replies are matched on their table/knight metadata; when a
// knight has several pods the most recently started one wins.
func (c *cardStore) requestStats(ctx context.Context) (map[string]json.RawMessage, error) {
	out := map[string]json.RawMessage{}
	if c.nc == nil {
		return out, errNATSUnavailable
	}
	inbox := c.nc.NewRespInbox()
	ch := make(chan *nats.Msg, 256)
	sub, err := c.nc.ChanSubscribe(inbox, ch)
	if err != nil {
		return out, err
	}
	defer sub.Unsubscribe()
	if err := c.nc.PublishRequest("$SRV.STATS."+knightServiceName, inbox, nil); err != nil {
		return out, err
	}
	started := map[string]time.Time{}
	timer := time.NewTimer(c.statsWait)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return out, nil
		case <-timer.C:
			return out, nil
		case msg := <-ch:
			var s struct {
				Metadata map[string]string `json:"metadata"`
				Started  time.Time         `json:"started"`
			}
			if json.Unmarshal(msg.Data, &s) != nil {
				continue
			}
			table, knight := s.Metadata["table"], s.Metadata["knight"]
			if table == "" || knight == "" {
				continue
			}
			key := cardStatsKey(table, knight)
			if prev, ok := started[key]; ok && !s.Started.After(prev) {
				continue
			}
			started[key] = s.Started
			out[key] = json.RawMessage(append([]byte(nil), msg.Data...))
		}
	}
}

// --- live push ---

func (c *cardStore) subscribe(fn func([]byte)) func() {
	c.subMu.Lock()
	defer c.subMu.Unlock()
	id := c.nextSub
	c.nextSub++
	c.subs[id] = fn
	return func() {
		c.subMu.Lock()
		delete(c.subs, id)
		c.subMu.Unlock()
	}
}

func (c *cardStore) hasSubscribers() bool {
	c.subMu.Lock()
	defer c.subMu.Unlock()
	return len(c.subs) > 0
}

func (c *cardStore) broadcast(data []byte) {
	c.subMu.Lock()
	defer c.subMu.Unlock()
	for _, fn := range c.subs {
		fn(data)
	}
}

// cardWSEvent encodes a card change in the shared TaskEvent envelope.
func cardWSEvent(op, table, knight string, payload interface{}) []byte {
	raw, _ := json.Marshal(payload)
	data, _ := json.Marshal(TaskEvent{
		Type:      "cards",
		Op:        op,
		Subject:   "cards." + table + "." + knight,
		Table:     table,
		Data:      raw,
		Timestamp: time.Now().UTC(),
	})
	return data
}

// handleUpdate broadcasts one KV change.
func (c *cardStore) handleUpdate(ctx context.Context, e jetstream.KeyValueEntry, tables []TableInfo) {
	table, knight, ok := splitCardKey(e.Key(), tables)
	if !ok || !c.hasSubscribers() {
		return
	}
	switch e.Operation() {
	case jetstream.KeyValueDelete, jetstream.KeyValuePurge:
		c.broadcast(cardWSEvent(chainOpDelete, table, knight, cardDeleted{Table: table, Knight: knight, Deleted: true}))
	default:
		if !json.Valid(e.Value()) {
			return
		}
		entry := CardEntry{Table: table, Knight: knight, Card: json.RawMessage(e.Value())}
		c.join(&entry, c.liveStats(ctx))
		c.broadcast(cardWSEvent(chainOpUpsert, table, knight, entry))
	}
}

// run watches <table>.* for every configured table until ctx is cancelled.
// It waits for the bucket to appear, and re-resolves tables and restarts the
// watch whenever it ends (or the table set changes).
func (c *cardStore) run(ctx context.Context) {
	for ctx.Err() == nil {
		c.watchOnce(ctx)
		c.sleep(ctx)
	}
}

func (c *cardStore) watchOnce(ctx context.Context) {
	tables := cardTables(c.tables(ctx))
	if len(tables) == 0 {
		return
	}
	kv, ok, err := c.keyValue(ctx)
	if err != nil || !ok {
		if err != nil && ctx.Err() == nil {
			slog.Warn("Cards: opening KV bucket failed", "bucket", c.bucket, "error", err)
		}
		return
	}
	filters := make([]string, 0, len(tables))
	for _, t := range tables {
		filters = append(filters, t.Name+".*")
	}
	w, err := kv.WatchFiltered(ctx, filters, jetstream.UpdatesOnly())
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("Cards: KV watch failed", "bucket", c.bucket, "error", err)
		}
		return
	}
	defer w.Stop()
	// Re-check the table set now and then so a new RoundTable is picked up.
	recheck := time.NewTicker(tableCacheTTL)
	defer recheck.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-recheck.C:
			if !sameTableNames(tables, cardTables(c.tables(ctx))) {
				return
			}
		case e, open := <-w.Updates():
			if !open {
				return
			}
			if e != nil {
				c.handleUpdate(ctx, e, tables)
			}
		}
	}
}

func sameTableNames(a, b []TableInfo) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name {
			return false
		}
	}
	return true
}

func (c *cardStore) sleep(ctx context.Context) {
	t := time.NewTimer(c.backoff)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// cardsHandler serves GET /api/cards[?table=<name>].
func cardsHandler(store *cardStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), cardListTimeout)
		defer cancel()
		tables := store.tables(ctx)
		if name := r.URL.Query().Get("table"); name != "" {
			t, ok := findTableByName(tables, name)
			if !ok {
				jsonError(w, "Unknown table", http.StatusBadRequest)
				return
			}
			tables = []TableInfo{t}
		}
		cards, err := store.list(ctx, tables)
		if err != nil {
			slog.Error("Cards: list failed", "bucket", store.bucket, "error", err)
			jsonError(w, "Cards unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"cards": cards})
	}
}
