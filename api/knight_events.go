package main

// Recent Kubernetes events of one knight (#529): the operator's Warning events
// (TaskLost, ToolsImageBuildFailed, ConsumerRecreated...) so a failing knight
// explains itself in the detail drawer without `kubectl describe`.

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/gorilla/mux"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// knightEventLimit caps how many events one response carries.
const knightEventLimit = 50

// KnightEvent is a safe projection of a Kubernetes Event (#46).
type KnightEvent struct {
	Type               string `json:"type"`
	Reason             string `json:"reason"`
	Message            string `json:"message"`
	Count              int32  `json:"count"`
	FirstTimestamp     string `json:"firstTimestamp,omitempty"`
	LastTimestamp      string `json:"lastTimestamp,omitempty"`
	ReportingComponent string `json:"reportingComponent,omitempty"`
}

func knightEventsHandler(namespace string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := mux.Vars(r)["knight"]
		if !validK8sName.MatchString(name) {
			jsonError(w, "Invalid knight name", http.StatusBadRequest)
			return
		}
		if dynClient == nil || k8sClient == nil {
			jsonError(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}
		kctx, cancel := k8sCtx(r)
		defer cancel()
		// Same 404 rule as knightHandler: an unknown knight is not found.
		if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Get(kctx, name, metav1.GetOptions{}); err != nil {
			writeGetError(w, r, err, "Knight", "knight", name)
			return
		}
		list, err := k8sClient.CoreV1().Events(namespace).List(kctx, metav1.ListOptions{
			FieldSelector: "involvedObject.kind=Knight,involvedObject.name=" + name,
		})
		if err != nil {
			slog.ErrorContext(r.Context(), "List knight events failed", "knight", name, "error", err)
			jsonError(w, "Failed to list events", http.StatusBadGateway)
			return
		}
		items := list.Items
		sort.SliceStable(items, func(i, j int) bool { return eventTime(&items[i]).After(eventTime(&items[j])) })
		if len(items) > knightEventLimit {
			items = items[:knightEventLimit]
		}
		out := make([]KnightEvent, 0, len(items))
		for i := range items {
			e := &items[i]
			ev := KnightEvent{
				Type: e.Type, Reason: e.Reason, Message: e.Message, Count: e.Count,
				ReportingComponent: e.ReportingController,
			}
			if e.Source.Component != "" {
				ev.ReportingComponent = e.Source.Component
			}
			if !e.FirstTimestamp.IsZero() {
				ev.FirstTimestamp = e.FirstTimestamp.UTC().Format(time.RFC3339)
			}
			if !e.LastTimestamp.IsZero() {
				ev.LastTimestamp = e.LastTimestamp.UTC().Format(time.RFC3339)
			} else if t := eventTime(e); !t.IsZero() {
				ev.LastTimestamp = t.UTC().Format(time.RFC3339)
			}
			out = append(out, ev)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	}
}
