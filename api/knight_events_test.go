package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	k8stesting "k8s.io/client-go/testing"
)

func knightEvent(name, knight, reason string, count int32, last time.Time) *corev1.Event {
	return &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: name, Namespace: "test-namespace"},
		InvolvedObject: corev1.ObjectReference{Kind: "Knight", Name: knight},
		Type:           "Warning", Reason: reason, Message: reason + " happened", Count: count,
		FirstTimestamp: metav1.NewTime(last.Add(-time.Hour)), LastTimestamp: metav1.NewTime(last),
		Source: corev1.EventSource{Component: "knight-controller"},
	}
}

func getKnightEvents(router http.Handler, knight string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/fleet/"+knight+"/events", nil))
	return w
}

func TestKnightEventsOrderLimitAndSelector(t *testing.T) {
	router := setupTestRouter()
	ns := "test-namespace"
	if _, err := dynClient.Resource(knightGVR).Namespace(ns).Create(nil, makeTestKnightCR("galahad", ns, "security"), metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	all := []*corev1.Event{knightEvent("other", "galahad-2", "Other", 1, now)}
	for i := 0; i < 55; i++ {
		all = append(all, knightEvent(fmt.Sprintf("e%d", i), "galahad", fmt.Sprintf("R%d", i), int32(i+1), now.Add(-time.Duration(i)*time.Minute)))
	}
	var selector string
	fakeK8sClient.PrependReactor("list", "events", func(a k8stesting.Action) (bool, runtime.Object, error) {
		selector = a.(k8stesting.ListAction).GetListRestrictions().Fields.String()
		list := &corev1.EventList{}
		for _, e := range all {
			// The fake client ignores field selectors; emulate the server.
			if e.InvolvedObject.Name == "galahad" {
				list.Items = append(list.Items, *e)
			}
		}
		// shuffle: reverse so the handler must sort
		for i, j := 0, len(list.Items)-1; i < j; i, j = i+1, j-1 {
			list.Items[i], list.Items[j] = list.Items[j], list.Items[i]
		}
		return true, list, nil
	})

	w := getKnightEvents(router, "galahad")
	if w.Code != 200 {
		t.Fatalf("got %d: %s", w.Code, w.Body.String())
	}
	if !strings.Contains(selector, "involvedObject.kind=Knight") || !strings.Contains(selector, "involvedObject.name=galahad") {
		t.Errorf("selector = %q", selector)
	}
	var evs []KnightEvent
	if err := json.Unmarshal(w.Body.Bytes(), &evs); err != nil {
		t.Fatal(err)
	}
	if len(evs) != 50 {
		t.Fatalf("want 50 events, got %d", len(evs))
	}
	if evs[0].Reason != "R0" || evs[49].Reason != "R49" {
		t.Errorf("not newest first: %s ... %s", evs[0].Reason, evs[49].Reason)
	}
	if evs[0].Type != "Warning" || evs[0].Count != 1 || evs[0].ReportingComponent != "knight-controller" || evs[0].FirstTimestamp == "" || evs[0].LastTimestamp == "" {
		t.Errorf("bad projection: %+v", evs[0])
	}
}

func TestKnightEventsEmptyIsArray(t *testing.T) {
	router := setupTestRouter()
	ns := "test-namespace"
	dynClient.Resource(knightGVR).Namespace(ns).Create(nil, makeTestKnightCR("galahad", ns, "security"), metav1.CreateOptions{})
	w := getKnightEvents(router, "galahad")
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Errorf("got %d %q", w.Code, w.Body.String())
	}
}

func TestKnightEventsErrorMapping(t *testing.T) {
	router := setupTestRouter()
	ns := "test-namespace"
	if w := getKnightEvents(router, "ghost"); w.Code != http.StatusNotFound {
		t.Errorf("unknown knight: got %d", w.Code)
	}
	if w := getKnightEvents(router, "Bad_Name"); w.Code != http.StatusBadRequest {
		t.Errorf("bad name: got %d", w.Code)
	}
	dynClient.Resource(knightGVR).Namespace(ns).Create(nil, makeTestKnightCR("galahad", ns, "security"), metav1.CreateOptions{})
	fakeK8sClient.PrependReactor("list", "events", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("secret-internal-detail")
	})
	w := getKnightEvents(router, "galahad")
	if w.Code != http.StatusBadGateway {
		t.Errorf("list error: got %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "secret-internal-detail") {
		t.Errorf("leaked error text: %s", w.Body.String())
	}
}
