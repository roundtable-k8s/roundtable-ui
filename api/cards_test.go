package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/nats-io/nats.go/micro"
)

// startCardsNATS runs an in-process NATS server with JetStream and returns a
// connection and JetStream context on it.
func startCardsNATS(t *testing.T) (*nats.Conn, jetstream.JetStream) {
	t.Helper()
	srv, err := server.NewServer(&server.Options{Host: "127.0.0.1", Port: -1, JetStream: true, StoreDir: t.TempDir(), NoLog: true, NoSigs: true})
	if err != nil {
		t.Fatal(err)
	}
	go srv.Start()
	if !srv.ReadyForConnections(5 * time.Second) {
		t.Fatal("nats server not ready")
	}
	t.Cleanup(srv.Shutdown)
	conn, err := nats.Connect(srv.ClientURL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(conn.Close)
	jsc, err := jetstream.New(conn)
	if err != nil {
		t.Fatal(err)
	}
	return conn, jsc
}

func createCardsBucket(t *testing.T, jsc jetstream.JetStream, bucket string) jetstream.KeyValue {
	t.Helper()
	kv, err := jsc.CreateKeyValue(context.Background(), jetstream.KeyValueConfig{Bucket: bucket, History: 1})
	if err != nil {
		t.Fatal(err)
	}
	return kv
}

func putCard(t *testing.T, kv jetstream.KeyValue, table, knight, description string) {
	t.Helper()
	card, _ := json.Marshal(map[string]interface{}{
		"schemaVersion": 1,
		"name":          knight,
		"description":   description,
		"roundtable":    map[string]interface{}{"table": table, "knight": knight},
	})
	if _, err := kv.Put(context.Background(), table+"."+knight, card); err != nil {
		t.Fatal(err)
	}
}

// startFakeKnight registers a roundtable-knight micro service like a knight
// pod does, with table/knight metadata and task counters as stats data.
func startFakeKnight(t *testing.T, conn *nats.Conn, table, knight string, active int) micro.Service {
	t.Helper()
	svc, err := micro.AddService(conn, micro.Config{
		Name:     knightServiceName,
		Version:  "1.0.0",
		Metadata: map[string]string{"table": table, "knight": knight},
		StatsHandler: func(*micro.Endpoint) any {
			return map[string]int{"activeTasks": active, "maxConcurrentTasks": 2}
		},
		Endpoint: &micro.EndpointConfig{
			Subject: "$RT." + table + "." + knight + ".card",
			Handler: micro.HandlerFunc(func(r micro.Request) { r.Respond([]byte("{}")) }),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { svc.Stop() })
	return svc
}

func testCardStore(conn *nats.Conn, jsc jetstream.JetStream, tables ...string) *cardStore {
	var infos []TableInfo
	for _, name := range tables {
		infos = append(infos, TableInfo{Name: name, Prefix: "fleet-" + name})
	}
	store := newCardStore(conn, jsc, "", func(context.Context) []TableInfo { return infos })
	store.statsWait = 150 * time.Millisecond
	store.backoff = 20 * time.Millisecond
	return store
}

func getCards(t *testing.T, store *cardStore, query string) (int, []CardEntry) {
	t.Helper()
	rec := httptest.NewRecorder()
	cardsHandler(store)(rec, httptest.NewRequest(http.MethodGet, "/api/cards"+query, nil))
	if rec.Code != http.StatusOK {
		return rec.Code, nil
	}
	var body struct {
		Cards []CardEntry `json:"cards"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	if body.Cards == nil {
		t.Fatalf("cards must be an array, got %s", rec.Body.String())
	}
	return rec.Code, body.Cards
}

func TestCardsHandlerReturnsCardsWithLiveStats(t *testing.T) {
	conn, jsc := startCardsNATS(t)
	kv := createCardsBucket(t, jsc, defaultCardsBucket)
	putCard(t, kv, "personal", "galahad", "Security analyst")
	putCard(t, kv, "personal", "kay", "Suspended knight")
	putCard(t, kv, "work", "tristan", "Other table")
	putCard(t, kv, "elsewhere", "mordred", "Not configured")
	startFakeKnight(t, conn, "personal", "Galahad", 1) // knight matched case-insensitively
	startFakeKnight(t, conn, "elsewhere", "kay", 0)    // same knight on another table: no match

	store := testCardStore(conn, jsc, "personal", "work")
	code, cards := getCards(t, store, "")
	if code != http.StatusOK {
		t.Fatalf("status = %d", code)
	}
	if len(cards) != 3 {
		t.Fatalf("cards = %+v", cards)
	}
	want := []struct {
		table, knight string
		live          bool
	}{{"personal", "galahad", true}, {"personal", "kay", false}, {"work", "tristan", false}}
	for i, w := range want {
		c := cards[i]
		if c.Table != w.table || c.Knight != w.knight || c.Live != w.live {
			t.Errorf("card %d = %s/%s live=%v, want %+v", i, c.Table, c.Knight, c.Live, w)
		}
	}

	var card struct {
		Description string `json:"description"`
	}
	json.Unmarshal(cards[0].Card, &card)
	if card.Description != "Security analyst" {
		t.Errorf("card JSON not passed through: %s", cards[0].Card)
	}
	var stats micro.Stats
	if err := json.Unmarshal(cards[0].Stats, &stats); err != nil {
		t.Fatalf("stats: %v (%s)", err, cards[0].Stats)
	}
	if stats.Name != knightServiceName || len(stats.Endpoints) != 1 || string(stats.Endpoints[0].Data) != `{"activeTasks":1,"maxConcurrentTasks":2}` {
		t.Errorf("stats = %s", cards[0].Stats)
	}
	if string(cards[1].Stats) != "null" && cards[1].Stats != nil {
		t.Errorf("non-live knight stats = %s, want null", cards[1].Stats)
	}

	// ?table= narrows to one table.
	_, cards = getCards(t, store, "?table=work")
	if len(cards) != 1 || cards[0].Knight != "tristan" {
		t.Errorf("?table=work cards = %+v", cards)
	}
	if code, _ := getCards(t, store, "?table=nope"); code != http.StatusBadRequest {
		t.Errorf("unknown table status = %d", code)
	}
}

func TestCardsHandlerMissingBucketIsEmpty(t *testing.T) {
	conn, jsc := startCardsNATS(t)
	store := testCardStore(conn, jsc, "personal")
	code, cards := getCards(t, store, "")
	if code != http.StatusOK || len(cards) != 0 {
		t.Fatalf("status=%d cards=%+v", code, cards)
	}
	// The dashboard must not create the bucket.
	if _, err := jsc.KeyValue(context.Background(), defaultCardsBucket); err == nil {
		t.Fatal("cards bucket was created")
	}
}

func TestCardsHandlerEmptyBucket(t *testing.T) {
	conn, jsc := startCardsNATS(t)
	createCardsBucket(t, jsc, defaultCardsBucket)
	code, cards := getCards(t, testCardStore(conn, jsc, "personal"), "")
	if code != http.StatusOK || len(cards) != 0 {
		t.Fatalf("status=%d cards=%+v", code, cards)
	}
}

func TestCardStatsCached(t *testing.T) {
	conn, jsc := startCardsNATS(t)
	store := testCardStore(conn, jsc, "personal")
	now := time.Unix(1000, 0)
	store.now = func() time.Time { return now }
	svc := startFakeKnight(t, conn, "personal", "galahad", 0)

	if _, ok := store.liveStats(context.Background())[cardStatsKey("personal", "galahad")]; !ok {
		t.Fatal("galahad not live")
	}
	svc.Stop()
	if _, ok := store.liveStats(context.Background())[cardStatsKey("personal", "galahad")]; !ok {
		t.Fatal("stats not cached within TTL")
	}
	now = now.Add(cardStatsTTL)
	if _, ok := store.liveStats(context.Background())[cardStatsKey("personal", "galahad")]; ok {
		t.Fatal("stats not refreshed after TTL")
	}
}

func TestCardStorePushesChanges(t *testing.T) {
	conn, jsc := startCardsNATS(t)
	store := testCardStore(conn, jsc, "personal")
	startFakeKnight(t, conn, "personal", "galahad", 1)

	events := make(chan TaskEvent, 16)
	unsub := store.subscribe(func(data []byte) {
		var ev TaskEvent
		if err := json.Unmarshal(data, &ev); err != nil {
			panic(err)
		}
		events <- ev
	})
	defer unsub()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { store.run(ctx); close(done) }()
	defer func() { cancel(); <-done }()

	// The bucket appears after the watcher started; keep writing until the
	// watcher (which retries with backoff) has picked it up.
	kv := createCardsBucket(t, jsc, defaultCardsBucket)
	next := func() TaskEvent {
		t.Helper()
		select {
		case ev := <-events:
			return ev
		case <-time.After(3 * time.Second):
			t.Fatal("no cards event")
		}
		return TaskEvent{}
	}
	var ev TaskEvent
	deadline := time.Now().Add(3 * time.Second)
	for {
		putCard(t, kv, "personal", "galahad", "v1")
		putCard(t, kv, "other", "kay", "ignored") // table not configured: never pushed
		select {
		case ev = <-events:
		case <-time.After(100 * time.Millisecond):
			if time.Now().After(deadline) {
				t.Fatal("no cards event after bucket creation")
			}
			continue
		}
		break
	}
	if ev.Type != "cards" || ev.Op != chainOpUpsert || ev.Table != "personal" || ev.Subject != "cards.personal.galahad" {
		t.Fatalf("event = %+v", ev)
	}
	var entry CardEntry
	if err := json.Unmarshal(ev.Data, &entry); err != nil {
		t.Fatal(err)
	}
	if entry.Table != "personal" || entry.Knight != "galahad" || !entry.Live || entry.Stats == nil || len(entry.Card) == 0 {
		t.Fatalf("entry = %+v", entry)
	}
	// Drain duplicates from the retry loop above.
	for drained := false; !drained; {
		select {
		case ev := <-events:
			if ev.Table != "personal" {
				t.Fatalf("pushed other table: %+v", ev)
			}
		case <-time.After(200 * time.Millisecond):
			drained = true
		}
	}

	putCard(t, kv, "personal", "galahad", "v2")
	ev = next()
	json.Unmarshal(ev.Data, &entry)
	var card struct {
		Description string `json:"description"`
	}
	json.Unmarshal(entry.Card, &card)
	if ev.Op != chainOpUpsert || card.Description != "v2" {
		t.Fatalf("update event = %+v card=%s", ev, entry.Card)
	}

	if err := kv.Delete(context.Background(), "personal.galahad"); err != nil {
		t.Fatal(err)
	}
	ev = next()
	var del cardDeleted
	json.Unmarshal(ev.Data, &del)
	if ev.Op != chainOpDelete || del != (cardDeleted{Table: "personal", Knight: "galahad", Deleted: true}) {
		t.Fatalf("delete event = %+v data=%s", ev, ev.Data)
	}
}

func TestSplitCardKey(t *testing.T) {
	tables := []TableInfo{{Name: "personal"}, {Name: "work"}}
	for key, want := range map[string][2]string{
		"personal.galahad": {"personal", "galahad"},
		"work.kay":         {"work", "kay"},
		"other.kay":        {},
		"personal.":        {},
		"personal.a.b":     {},
	} {
		table, knight, ok := splitCardKey(key, tables)
		if ok != (want[0] != "") || table != want[0] || knight != want[1] {
			t.Errorf("splitCardKey(%q) = %q %q %v", key, table, knight, ok)
		}
	}
	if got := cardTables([]TableInfo{{Name: "ok-1"}, {Name: "bad.name"}, {Name: "*"}}); len(got) != 1 || got[0].Name != "ok-1" {
		t.Errorf("cardTables = %+v", got)
	}
}
