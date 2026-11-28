package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/gorilla/mux"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// Trigger endpoints (#266, part of roundtable#399): a read-only view of the
// Trigger resource — what it listens to, which chain it starts, and its
// recent firings. Needs get/list on triggers.ai.roundtable.io.

var triggerGVR = schema.GroupVersionResource{
	Group:    "ai.roundtable.io",
	Version:  "v1alpha1",
	Resource: "triggers",
}

// TriggerSource summarises spec.source: its type and the key fields of it.
// Secret references are never exposed, only the auth scheme.
type TriggerSource struct {
	// Type is schedule, nats, webhook, github or unknown.
	Type string `json:"type"`
	// Detail is a one-line human summary (cron expression, subject…).
	Detail string `json:"detail"`

	Cron      string `json:"cron,omitempty"`
	TimeZone  string `json:"timeZone,omitempty"`
	Subject   string `json:"subject,omitempty"`
	EventType string `json:"eventType,omitempty"`
	// Auth is bearer, hmac or none for webhook sources.
	Auth string `json:"auth,omitempty"`
}

// TriggerFiring is one entry of status.recentFirings.
type TriggerFiring struct {
	Time       string `json:"time"`
	Key        string `json:"key,omitempty"`
	Run        string `json:"run,omitempty"`
	SkipReason string `json:"skipReason,omitempty"`
}

// TriggerCondition is a status condition.
type TriggerCondition struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// TriggerSummary is the API response for a Trigger.
type TriggerSummary struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	// TargetKind is chain, knight or mission.
	TargetKind string `json:"targetKind"`

	Source      TriggerSource `json:"source"`
	TargetChain string        `json:"targetChain"`
	// TargetKnight is spec.target.knight.name for a knight target.
	TargetKnight string `json:"targetKnight,omitempty"`
	// Task is what a firing sends: the knight target's task, the mission
	// target's objective, else spec.input (all Go templates, unrendered).
	Task string `json:"task,omitempty"`
	// Concurrency policy (Allow, Forbid, Replace) and maxActive (0 = default).
	ConcurrencyPolicy string `json:"concurrencyPolicy"`
	MaxActive         int    `json:"maxActive,omitempty"`
	Suspended         bool   `json:"suspended"`
	RoundTableRef     string `json:"roundTableRef,omitempty"`
	// Table is the target chain's roundTableRef (else the trigger's own),
	// "none" when neither is set (#273).
	Table string `json:"table"`

	LastFiredAt     *string `json:"lastFiredAt,omitempty"`
	LastScheduledAt *string `json:"lastScheduledAt,omitempty"`
	NextScheduledAt *string `json:"nextScheduledAt,omitempty"`

	RecentFirings []TriggerFiring    `json:"recentFirings"`
	ActiveRuns    []string           `json:"activeRuns"`
	Conditions    []TriggerCondition `json:"conditions"`
	// Ready is true / false / unknown from the Ready condition.
	Ready string `json:"ready"`
}

func parseTriggerSource(src map[string]interface{}) TriggerSource {
	if m := getNestedMap(src, "schedule"); m != nil {
		s := TriggerSource{Type: "schedule", Cron: getStr(m, "cron"), TimeZone: getStr(m, "timeZone")}
		s.Detail = s.Cron
		if s.TimeZone != "" {
			s.Detail += " (" + s.TimeZone + ")"
		}
		return s
	}
	if m := getNestedMap(src, "nats"); m != nil {
		s := TriggerSource{Type: "nats", Subject: getStr(m, "subject")}
		s.Detail = s.Subject
		return s
	}
	if m := getNestedMap(src, "webhook"); m != nil {
		s := TriggerSource{Type: "webhook", EventType: getStr(m, "eventType"), Auth: "none"}
		auth := getNestedMap(m, "auth")
		if getNestedMap(auth, "hmacSecretRef") != nil {
			s.Auth = "hmac"
		} else if getNestedMap(auth, "bearerTokenSecretRef") != nil {
			s.Auth = "bearer"
		}
		s.Detail = "webhook, " + s.Auth + " auth"
		if s.EventType != "" {
			s.Detail = s.EventType + " · " + s.Detail
		}
		return s
	}
	if getNestedMap(src, "github") != nil {
		return TriggerSource{Type: "github", Detail: "github (reserved)"}
	}
	return TriggerSource{Type: "unknown"}
}

func parseTriggerResource(obj map[string]interface{}) TriggerSummary {
	spec := getNestedMap(obj, "spec")
	status := getNestedMap(obj, "status")
	meta := getNestedMap(obj, "metadata")

	t := TriggerSummary{
		Name:              getStr(meta, "name"),
		Namespace:         getStr(meta, "namespace"),
		Source:            parseTriggerSource(getNestedMap(spec, "source")),
		TargetChain:       getRefName(getNestedMap(spec, "target"), "chainRef"),
		ConcurrencyPolicy: getStr(getNestedMap(spec, "concurrency"), "policy"),
		MaxActive:         getInt(getNestedMap(spec, "concurrency"), "maxActive"),
		Suspended:         getBool(spec, "suspend"),
		RoundTableRef:     getRefName(spec, "roundTableRef"),
		Table:             tableOrNone(getRefName(spec, "roundTableRef")),
		LastFiredAt:       optStr(getStr(status, "lastFiredAt")),
		LastScheduledAt:   optStr(getStr(status, "lastScheduledAt")),
		NextScheduledAt:   optStr(getStr(status, "nextScheduledAt")),
		RecentFirings:     []TriggerFiring{},
		ActiveRuns:        []string{},
		Conditions:        []TriggerCondition{},
		Ready:             "unknown",
	}
	target := getNestedMap(spec, "target")
	t.TargetKind = "chain"
	if k := getNestedMap(target, "knight"); k != nil {
		t.TargetKnight = getStr(k, "name")
		t.Task = getStr(k, "task")
		t.TargetKind = "knight"
	} else if m := getNestedMap(target, "mission"); m != nil {
		t.TargetKind = "mission"
		t.Task = getStr(m, "objective")
	} else {
		t.Task = getStr(spec, "input")
	}
	if t.ConcurrencyPolicy == "" {
		t.ConcurrencyPolicy = "Allow"
	}
	for _, f := range getSlice(status, "recentFirings") {
		fm, ok := f.(map[string]interface{})
		if !ok {
			continue
		}
		t.RecentFirings = append(t.RecentFirings, TriggerFiring{
			Time: getStr(fm, "time"), Key: getStr(fm, "key"),
			Run: getStr(fm, "run"), SkipReason: getStr(fm, "skipReason"),
		})
	}
	for _, r := range getSlice(status, "activeRuns") {
		if s, ok := r.(string); ok {
			t.ActiveRuns = append(t.ActiveRuns, s)
		}
	}
	for _, c := range getSlice(status, "conditions") {
		cm, ok := c.(map[string]interface{})
		if !ok {
			continue
		}
		cond := TriggerCondition{Type: getStr(cm, "type"), Status: getStr(cm, "status"),
			Reason: getStr(cm, "reason"), Message: getStr(cm, "message")}
		t.Conditions = append(t.Conditions, cond)
		if cond.Type == "Ready" {
			switch cond.Status {
			case "True":
				t.Ready = "true"
			case "False":
				t.Ready = "false"
			}
		}
	}
	return t
}

func triggersHandler(namespace string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if dynClient == nil {
			jsonError(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}
		items, err := cachedList(r.Context(), dynClient, triggerGVR, namespace)
		if err != nil {
			slog.ErrorContext(r.Context(), "Trigger list error", "error", err)
			jsonError(w, "Failed to list triggers", http.StatusInternalServerError)
			return
		}
		chainTables := chainTableMap(r.Context(), namespace)
		filter := tableFilter(r)
		out := []TriggerSummary{}
		for _, item := range items {
			t := parseTriggerResource(item.Object)
			applyTriggerTable(&t, chainTables)
			if !tableMatches(filter, t.Table) {
				continue
			}
			out = append(out, t)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	}
}

func triggerDetailHandler(namespace string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if dynClient == nil {
			jsonError(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}
		vars := mux.Vars(r)
		ns, name := vars["namespace"], vars["name"]
		if !validResourceName.MatchString(name) {
			jsonError(w, "Invalid trigger name", http.StatusBadRequest)
			return
		}
		// The dashboard only reads its own namespace.
		if ns != namespace {
			jsonError(w, "Trigger not found", http.StatusNotFound)
			return
		}
		obj, err := dynClient.Resource(triggerGVR).Namespace(namespace).Get(r.Context(), name, metav1.GetOptions{})
		if err != nil {
			writeK8sError(w, r, err, "read", "trigger")
			return
		}
		t := parseTriggerResource(obj.Object)
		applyTriggerTable(&t, chainTableMap(r.Context(), namespace))
		setSpanTable(r.Context(), t.RoundTableRef)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(t)
	}
}

// chainTableMap maps chain name to its roundTableRef. Best effort: empty on
// error.
func chainTableMap(ctx context.Context, namespace string) map[string]string {
	out := map[string]string{}
	if dynClient == nil {
		return out
	}
	items, err := cachedList(ctx, dynClient, chainGVR, namespace)
	if err != nil {
		return out
	}
	for _, item := range items {
		out[item.GetName()] = getRefName(getNestedMap(item.Object, "spec"), "roundTableRef")
	}
	return out
}

// applyTriggerTable sets the trigger's table from its target chain.
func applyTriggerTable(t *TriggerSummary, chainTables map[string]string) {
	if ref := chainTables[t.TargetChain]; ref != "" {
		t.Table = ref
	}
}
