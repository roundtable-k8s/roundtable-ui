package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"github.com/nats-io/nats.go/jetstream"
)

// kvRequest serves h at pattern and returns the recorded response for path.
func kvRequest(h http.HandlerFunc, pattern, path string) *httptest.ResponseRecorder {
	r := mux.NewRouter()
	r.HandleFunc(pattern, h).Methods("GET")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
	return rec
}

func useJS(t *testing.T, jsc jetstream.JetStream) {
	t.Helper()
	old := js
	js = jsc
	t.Cleanup(func() { js = old })
}

func bucketExists(t *testing.T, jsc jetstream.JetStream, bucket string) bool {
	t.Helper()
	_, err := jsc.KeyValue(context.Background(), bucket)
	return err == nil
}

func TestMissionResultsHandler(t *testing.T) {
	_, jsc := startCardsNATS(t)
	useJS(t, jsc)
	kv := createCardsBucket(t, jsc, "mission-results")
	if _, err := kv.Put(context.Background(), "m1", []byte(`{"out":"ok","token":"supersecretvalue"}`)); err != nil {
		t.Fatal(err)
	}
	const pat = "/api/missions/{name}/results"

	rec := kvRequest(missionResultsHandler(), pat, "/api/missions/m1/results")
	if rec.Code != 200 {
		t.Fatalf("found: status %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"out":"ok"`) || strings.Contains(body, "supersecretvalue") || !strings.Contains(body, redactedMarker) {
		t.Errorf("expected redacted body, got %s", body)
	}
	if rec := kvRequest(missionResultsHandler(), pat, "/api/missions/nope/results"); rec.Code != 404 {
		t.Errorf("missing key: status %d", rec.Code)
	}
	if rec := kvRequest(missionResultsHandler(), pat, "/api/missions/1bad/results"); rec.Code != 400 {
		t.Errorf("invalid name: status %d", rec.Code)
	}
}

func TestChainStepOutputHandler(t *testing.T) {
	_, jsc := startCardsNATS(t)
	useJS(t, jsc)
	kv := createCardsBucket(t, jsc, "chain-outputs")
	if _, err := kv.Put(context.Background(), "c1.s1", []byte(`{"out":"ok","password":"hunter2hunter2"}`)); err != nil {
		t.Fatal(err)
	}
	const pat = "/api/chains/{name}/steps/{step}/output"

	rec := kvRequest(chainStepOutputHandler(), pat, "/api/chains/c1/steps/s1/output")
	if rec.Code != 200 {
		t.Fatalf("found: status %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"out":"ok"`) || strings.Contains(body, "hunter2hunter2") || !strings.Contains(body, redactedMarker) {
		t.Errorf("expected redacted body, got %s", body)
	}
	if rec := kvRequest(chainStepOutputHandler(), pat, "/api/chains/c1/steps/zz/output"); rec.Code != 404 {
		t.Errorf("missing key: status %d", rec.Code)
	}
	if rec := kvRequest(chainStepOutputHandler(), pat, "/api/chains/c1/steps/9x/output"); rec.Code != 400 {
		t.Errorf("invalid name: status %d", rec.Code)
	}
}

func TestKVHandlersMissingBucketNotCreated(t *testing.T) {
	_, jsc := startCardsNATS(t)
	useJS(t, jsc)

	rec := kvRequest(missionResultsHandler(), "/api/missions/{name}/results", "/api/missions/m1/results")
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "Results not found") {
		t.Errorf("results: status %d body %s", rec.Code, rec.Body.String())
	}
	rec = kvRequest(chainStepOutputHandler(), "/api/chains/{name}/steps/{step}/output", "/api/chains/c1/steps/s1/output")
	if rec.Code != 404 || !strings.Contains(rec.Body.String(), "Output not found") {
		t.Errorf("output: status %d body %s", rec.Code, rec.Body.String())
	}
	for _, b := range []string{"mission-results", "chain-outputs"} {
		if bucketExists(t, jsc, b) {
			t.Errorf("bucket %s was created by a GET", b)
		}
	}
}

// TestKVRoutesAreGone asserts that no API route matches the removed /api/kv
// paths in the router setupTestRouter builds. Production answers unmatched
// paths with the SPA fallback (200 index.html, no /api guard), so this test
// checks route matching, not the HTTP response.
func TestKVRoutesAreGone(t *testing.T) {
	router := setupTestRouter()
	for _, path := range []string{"/api/kv/anything", "/api/kv/buckets", "/api/kv/buckets/mission-results"} {
		for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodPost} {
			req := httptest.NewRequest(method, path, nil)
			var m mux.RouteMatch
			if router.Match(req, &m) {
				t.Errorf("%s %s matched route %v; the /api/kv routes were removed", method, path, m.Route.GetName())
			}
		}
	}
}
