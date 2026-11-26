package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

func trigObj(name string, source map[string]interface{}, status map[string]interface{}) map[string]interface{} {
	o := map[string]interface{}{
		"apiVersion": "ai.roundtable.io/v1alpha1",
		"kind":       "Trigger",
		"metadata":   map[string]interface{}{"name": name, "namespace": "roundtable"},
		"spec": map[string]interface{}{
			"source":      source,
			"target":      map[string]interface{}{"chainRef": map[string]interface{}{"name": "nightly-scan"}},
			"concurrency": map[string]interface{}{"policy": "Forbid", "maxActive": float64(2)},
			"suspend":     true,
		},
	}
	if status != nil {
		o["status"] = status
	}
	return o
}

func setupTriggerRouter(t *testing.T, objs ...map[string]interface{}) *mux.Router {
	t.Helper()
	old := dynClient
	t.Cleanup(func() { dynClient = old })
	t.Cleanup(resetListCache)
	dynClient = fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{triggerGVR: "TriggerList", chainGVR: "ChainList"})
	for _, o := range objs {
		if _, err := dynClient.Resource(triggerGVR).Namespace("roundtable").Create(context.Background(),
			&unstructured.Unstructured{Object: o}, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	r := mux.NewRouter()
	r.HandleFunc("/api/triggers", triggersHandler("roundtable"))
	r.HandleFunc("/api/triggers/{namespace}/{name}", triggerDetailHandler("roundtable"))
	return r
}

func TestTriggersHandlers(t *testing.T) {
	r := setupTriggerRouter(t,
		trigObj("nightly", map[string]interface{}{"schedule": map[string]interface{}{"cron": "0 3 * * *", "timeZone": "UTC"}},
			map[string]interface{}{
				"lastFiredAt":     "2026-11-25T03:00:00Z",
				"nextScheduledAt": "2026-11-26T03:00:00Z",
				"activeRuns":      []interface{}{"nightly-scan-1"},
				"recentFirings": []interface{}{
					map[string]interface{}{"time": "2026-11-25T03:00:00Z", "key": "k1", "run": "nightly-scan-1"},
					map[string]interface{}{"time": "2026-11-24T03:00:00Z", "key": "k0", "skipReason": "ConcurrencyForbid"},
				},
				"conditions": []interface{}{map[string]interface{}{"type": "Ready", "status": "True"}},
			}),
		trigObj("on-event", map[string]interface{}{"nats": map[string]interface{}{"subject": "events.deploy"}}, nil),
		trigObj("hook", map[string]interface{}{"webhook": map[string]interface{}{
			"eventType": "push",
			"auth":      map[string]interface{}{"hmacSecretRef": map[string]interface{}{"name": "s", "key": "k"}},
		}}, nil),
	)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/triggers", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var list []TriggerSummary
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil || len(list) != 3 {
		t.Fatalf("list: %v %s", err, w.Body.String())
	}
	types := map[string]string{}
	for _, tr := range list {
		types[tr.Name] = tr.Source.Type
	}
	if types["nightly"] != "schedule" || types["on-event"] != "nats" || types["hook"] != "webhook" {
		t.Errorf("source types = %v", types)
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/triggers/roundtable/nightly", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("detail status %d: %s", w.Code, w.Body.String())
	}
	var d TriggerSummary
	if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.Source.Cron != "0 3 * * *" || d.Source.TimeZone != "UTC" || d.TargetChain != "nightly-scan" ||
		d.ConcurrencyPolicy != "Forbid" || d.MaxActive != 2 || !d.Suspended || d.Ready != "true" {
		t.Errorf("detail = %+v", d)
	}
	if d.LastFiredAt == nil || *d.LastFiredAt != "2026-11-25T03:00:00Z" || d.NextScheduledAt == nil {
		t.Errorf("times = %+v", d)
	}
	if len(d.ActiveRuns) != 1 || len(d.RecentFirings) != 2 || d.RecentFirings[1].SkipReason != "ConcurrencyForbid" || d.RecentFirings[0].Run != "nightly-scan-1" {
		t.Errorf("firings/runs = %+v", d)
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/triggers/roundtable/hook", nil))
	var h TriggerSummary
	json.Unmarshal(w.Body.Bytes(), &h)
	if h.Source.Auth != "hmac" || h.Source.EventType != "push" || h.Ready != "unknown" {
		t.Errorf("webhook = %+v", h)
	}

	for path, want := range map[string]int{
		"/api/triggers/roundtable/missing": http.StatusNotFound,
		"/api/triggers/other/nightly":      http.StatusNotFound,
		"/api/triggers/roundtable/BAD..":   http.StatusBadRequest,
	} {
		w = httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code != want {
			t.Errorf("%s: status %d, want %d", path, w.Code, want)
		}
	}
}

func TestTriggersHandler_Empty(t *testing.T) {
	r := setupTriggerRouter(t)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/triggers", nil))
	if w.Code != http.StatusOK || w.Body.String() != "[]\n" {
		t.Errorf("status %d body %q", w.Code, w.Body.String())
	}
}

func TestTriggerDetailHandler_GetErrors(t *testing.T) {
	r := setupTriggerRouter(t, trigObj("nightly", map[string]interface{}{"schedule": map[string]interface{}{"cron": "0 3 * * *"}}, nil))
	dynClient.(*fake.FakeDynamicClient).PrependReactor("get", "triggers", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if action.(k8stesting.GetAction).GetName() == "nightly" {
			return true, nil, apierrors.NewForbidden(triggerGVR.GroupResource(), "nightly", nil)
		}
		return false, nil, nil
	})

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/triggers/roundtable/nightly", nil))
	if w.Code != http.StatusInternalServerError {
		t.Errorf("forbidden get: status %d, want 500: %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "not found") {
		t.Errorf("forbidden get: body says not found: %s", w.Body.String())
	}

	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/triggers/roundtable/missing", nil))
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "Trigger not found") {
		t.Errorf("missing trigger: status %d body %s, want 404 Trigger not found", w.Code, w.Body.String())
	}
}

func TestParseTriggerTask(t *testing.T) {
	spec := func(target map[string]interface{}, input string) map[string]interface{} {
		s := map[string]interface{}{"source": map[string]interface{}{"schedule": map[string]interface{}{"cron": "0 7 * * *"}}, "target": target}
		if input != "" {
			s["input"] = input
		}
		return map[string]interface{}{"metadata": map[string]interface{}{"name": "x", "namespace": "roundtable"}, "spec": s}
	}
	knight := parseTriggerResource(spec(map[string]interface{}{"knight": map[string]interface{}{"name": "galahad", "task": "Scan the cluster\nthen report"}}, ""))
	if knight.TargetKnight != "galahad" || knight.Task != "Scan the cluster\nthen report" || knight.TargetChain != "" {
		t.Errorf("knight target: %+v", knight)
	}
	mission := parseTriggerResource(spec(map[string]interface{}{"mission": map[string]interface{}{"objective": "Ship it"}}, ""))
	if mission.Task != "Ship it" || mission.TargetKnight != "" {
		t.Errorf("mission target: %+v", mission)
	}
	chain := parseTriggerResource(spec(map[string]interface{}{"chainRef": map[string]interface{}{"name": "digest"}}, "Digest for today"))
	if chain.Task != "Digest for today" || chain.TargetChain != "digest" {
		t.Errorf("chain target: %+v", chain)
	}
}
