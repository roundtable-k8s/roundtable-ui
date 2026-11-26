package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestDetailHandlers_GetErrors(t *testing.T) {
	gr := schema.GroupResource{Group: "ai.roundtable.io"}
	cases := []struct {
		name, path, resource, notFound string
		err                            error
		want                           int
	}{
		{"knight forbidden", "/api/fleet/x", "knights", "Knight not found", apierrors.NewForbidden(gr, "x", errors.New("rbac secret")), 500},
		{"knight timeout", "/api/fleet/x", "knights", "Knight not found", apierrors.NewTimeoutError("etcd secret", 1), 502},
		{"chain forbidden", "/api/chains/x", "chains", "Chain not found", apierrors.NewForbidden(gr, "x", errors.New("rbac secret")), 500},
		{"chain unavailable", "/api/chains/x", "chains", "Chain not found", apierrors.NewServiceUnavailable("down secret"), 502},
		{"mission forbidden", "/api/missions/x", "missions", "Mission not found", apierrors.NewForbidden(gr, "x", errors.New("rbac secret")), 500},
		{"mission deadline", "/api/missions/x", "missions", "Mission not found", context.DeadlineExceeded, 502},
		{"roundtable forbidden", "/api/roundtables/x", "roundtables", "RoundTable not found", apierrors.NewForbidden(gr, "x", errors.New("rbac secret")), 500},
		{"queue forbidden", "/api/fleet/x/queue", "knights", "Knight not found", apierrors.NewForbidden(gr, "x", errors.New("rbac secret")), 500},
		{"queue timeout", "/api/fleet/x/queue", "knights", "Knight not found", apierrors.NewServerTimeout(gr, "get", 1), 502},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			router := setupTestRouter()
			withQueueFixture(t, newFakeJetStream(), time.Now())
			dynClient.(*fake.FakeDynamicClient).PrependReactor("get", c.resource, func(k8stesting.Action) (bool, runtime.Object, error) {
				return true, nil, c.err
			})
			w := httptest.NewRecorder()
			router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, c.path, nil))
			if w.Code != c.want {
				t.Errorf("status %d, want %d: %s", w.Code, c.want, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "not found") || strings.Contains(w.Body.String(), "secret") {
				t.Errorf("body leaks or claims missing: %s", w.Body.String())
			}
		})
	}

	// A really missing object is still 404.
	for _, c := range cases {
		router := setupTestRouter()
		withQueueFixture(t, newFakeJetStream(), time.Now())
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest(http.MethodGet, c.path, nil))
		if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), c.notFound) {
			t.Errorf("%s missing: status %d body %s, want 404 %s", c.path, w.Code, w.Body.String(), c.notFound)
		}
	}
}

type errKV struct {
	jetstream.KeyValue
	err error
}

func (e errKV) Get(context.Context, string) (jetstream.KeyValueEntry, error) { return nil, e.err }

type errJS struct {
	jetstream.JetStream
	kv  jetstream.KeyValue
	err error
}

func (e errJS) KeyValue(context.Context, string) (jetstream.KeyValue, error) { return e.kv, e.err }

func TestKVHandlers_NonNotFoundErrors(t *testing.T) {
	cases := []struct {
		name string
		js   errJS
		want int
	}{
		{"bucket lookup fails", errJS{err: errors.New("nats: no responders available")}, 500},
		{"bucket missing", errJS{err: jetstream.ErrBucketNotFound}, 404},
		{"get fails", errJS{kv: errKV{err: errors.New("nats: timeout")}}, 500},
		{"key missing", errJS{kv: errKV{err: jetstream.ErrKeyNotFound}}, 404},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			useJS(t, c.js)
			for _, rec := range []*httptest.ResponseRecorder{
				kvRequest(missionResultsHandler(), "/api/missions/{name}/results", "/api/missions/m1/results"),
				kvRequest(chainStepOutputHandler(), "/api/chains/{name}/steps/{step}/output", "/api/chains/c1/steps/s1/output"),
			} {
				if rec.Code != c.want {
					t.Errorf("status %d, want %d: %s", rec.Code, c.want, rec.Body.String())
				}
				b := rec.Body.String()
				if strings.Contains(b, "KV bucket") || strings.Contains(b, "nats:") {
					t.Errorf("body leaks internal text: %s", b)
				}
			}
		})
	}
}
