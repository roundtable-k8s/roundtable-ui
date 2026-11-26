package main

import (
	"context"
	"log/slog"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Isolation states shown on the dashboard (#269).
const (
	isolationStateIsolated    = "isolated"     // Isolated=True
	isolationStateOptedOut    = "opted-out"    // spec.isolation opts out
	isolationStateNotEnforced = "not-enforced" // Isolated=False for any other reason
	isolationStateUnknown     = "unknown"      // no Isolated condition (older operator, not reconciled yet)
)

// Operator condition types and reasons (roundtable-k8s/roundtable#387, #517).
const (
	condIsolated               = "Isolated"
	condEgressRestricted       = "EgressRestricted"
	reasonIsolationOptedOut    = "OptedOut"
	reasonFQDNPolicyApplied    = "FQDNPolicyApplied"
	reasonEgressServiceMissing = "ServiceNotFound"
)

// Labels linking a standing knight to its RoundTable, as read by the operator.
const (
	labelRoundTable       = "ai.roundtable.io/round-table"
	labelRoundTableLegacy = "ai.roundtable.io/table"
)

// KnightConditionInfo is a status condition of the Knight CR.
type KnightConditionInfo struct {
	Type               string `json:"type"`
	Status             string `json:"status"`
	Reason             string `json:"reason,omitempty"`
	Message            string `json:"message,omitempty"`
	LastTransitionTime string `json:"lastTransitionTime,omitempty"`
}

// EgressServiceInfo is an in-cluster Service the knight may reach.
type EgressServiceInfo struct {
	Name      string  `json:"name"`
	Namespace string  `json:"namespace,omitempty"`
	Ports     []int32 `json:"ports"`
}

// EgressHostInfo is an allowed host, optionally restricted to its own ports
// (an object entry of spec.egress.allowedHosts; roundtable#527).
type EgressHostInfo struct {
	Host  string  `json:"host"`
	Ports []int32 `json:"ports,omitempty"`
}

// KnightEgressInfo is the knight's effective egress allowlist.
type KnightEgressInfo struct {
	// AllowedHosts lists every allowed host name, including object entries.
	AllowedHosts []string `json:"allowedHosts"`
	// AllowedHostEntries lists the same hosts with their per-host ports.
	AllowedHostEntries []EgressHostInfo    `json:"allowedHostEntries"`
	AllowedPorts       []int32             `json:"allowedPorts"`
	AllowedServices    []EgressServiceInfo `json:"allowedServices"`
	// Source is "knight" (spec.egress) or "table" (the RoundTable's
	// spec.defaults.egress).
	Source string `json:"source"`
}

// KnightIsolationInfo reports how isolated a knight is and what it may reach.
type KnightIsolationInfo struct {
	State string `json:"state"`
	// Reason and Message come from the Isolated condition.
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
	// RuntimeOptOut / EgressOptOut mirror spec.isolation.runtime: none and
	// spec.isolation.egress: unrestricted; OptOutReason is spec.isolation.reason.
	RuntimeOptOut bool   `json:"runtimeOptOut,omitempty"`
	EgressOptOut  bool   `json:"egressOptOut,omitempty"`
	OptOutReason  string `json:"optOutReason,omitempty"`
	// RuntimeClassName is the effective RuntimeClass: the pod's when a pod
	// exists, else the knight's or its table's default. Empty when none is
	// known (the operator default is not visible to the dashboard).
	RuntimeClassName string `json:"runtimeClassName,omitempty"`
	// HostnameRulesEnforced is true only when the CiliumNetworkPolicy with
	// hostname (toFQDNs) rules is applied.
	HostnameRulesEnforced bool                 `json:"hostnameRulesEnforced"`
	Egress                *KnightEgressInfo    `json:"egress,omitempty"`
	Isolated              *KnightConditionInfo `json:"isolated,omitempty"`
	EgressRestricted      *KnightConditionInfo `json:"egressRestricted,omitempty"`
}

// knightTableName returns the RoundTable a standing knight belongs to.
func knightTableName(cr *unstructured.Unstructured) string {
	labels := cr.GetLabels()
	if t := labels[labelRoundTable]; t != "" {
		return t
	}
	return labels[labelRoundTableLegacy]
}

// tableDefaultsByName lists RoundTables once and returns each table's
// spec.defaults, keyed by name. Best effort: nil on error.
func tableDefaultsByName(ctx context.Context, namespace string) map[string]map[string]interface{} {
	if dynClient == nil {
		return nil
	}
	list, err := dynClient.Resource(roundTableGVR).Namespace(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		slog.DebugContext(ctx, "RoundTable list for isolation defaults failed", "error", err)
		return nil
	}
	out := make(map[string]map[string]interface{}, len(list.Items))
	for i := range list.Items {
		out[list.Items[i].GetName()] = getNestedMap(getNestedMap(list.Items[i].Object, "spec"), "defaults")
	}
	return out
}

// tableDefaultsFor fetches one RoundTable's spec.defaults. Best effort.
func tableDefaultsFor(ctx context.Context, namespace, table string) map[string]interface{} {
	if dynClient == nil || table == "" {
		return nil
	}
	obj, err := dynClient.Resource(roundTableGVR).Namespace(namespace).Get(ctx, table, metav1.GetOptions{})
	if err != nil {
		return nil
	}
	return getNestedMap(getNestedMap(obj.Object, "spec"), "defaults")
}

// findCRCondition returns the status condition of the given type, or nil.
func findCRCondition(status map[string]interface{}, condType string) *KnightConditionInfo {
	for _, c := range getSlice(status, "conditions") {
		m, ok := c.(map[string]interface{})
		if !ok || getStr(m, "type") != condType {
			continue
		}
		return &KnightConditionInfo{
			Type:               condType,
			Status:             getStr(m, "status"),
			Reason:             getStr(m, "reason"),
			Message:            getStr(m, "message"),
			LastTransitionTime: getStr(m, "lastTransitionTime"),
		}
	}
	return nil
}

// int32List reads a list of integers (JSON numbers) from an unstructured slice.
func int32List(items []interface{}) []int32 {
	out := make([]int32, 0, len(items))
	for _, v := range items {
		switch n := v.(type) {
		case int64:
			out = append(out, int32(n))
		case float64:
			out = append(out, int32(n))
		case int:
			out = append(out, int32(n))
		case int32:
			out = append(out, n)
		}
	}
	return out
}

// parseEgress converts a KnightEgress object into the DTO.
func parseEgress(m map[string]interface{}, source string) *KnightEgressInfo {
	e := &KnightEgressInfo{
		AllowedHosts:       []string{},
		AllowedHostEntries: []EgressHostInfo{},
		AllowedPorts:       int32List(getSlice(m, "allowedPorts")),
		AllowedServices:    []EgressServiceInfo{},
		Source:             source,
	}
	for _, h := range getSlice(m, "allowedHosts") {
		switch v := h.(type) {
		case string:
			e.AllowedHosts = append(e.AllowedHosts, v)
			e.AllowedHostEntries = append(e.AllowedHostEntries, EgressHostInfo{Host: v})
		case map[string]interface{}:
			host := getStr(v, "host")
			if host == "" {
				continue
			}
			e.AllowedHosts = append(e.AllowedHosts, host)
			e.AllowedHostEntries = append(e.AllowedHostEntries, EgressHostInfo{Host: host, Ports: int32List(getSlice(v, "ports"))})
		}
	}
	for _, s := range getSlice(m, "allowedServices") {
		sm, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		e.AllowedServices = append(e.AllowedServices, EgressServiceInfo{
			Name:      getStr(sm, "name"),
			Namespace: getStr(sm, "namespace"),
			Ports:     int32List(getSlice(sm, "ports")),
		})
	}
	return e
}

// buildKnightIsolation derives the knight's isolation report from its CR, its
// preferred pod and its table's spec.defaults (any may be nil).
func buildKnightIsolation(cr *unstructured.Unstructured, pod *corev1.Pod, tableDefaults map[string]interface{}) *KnightIsolationInfo {
	spec := getNestedMap(cr.Object, "spec")
	status := getNestedMap(cr.Object, "status")
	iso := getNestedMap(spec, "isolation")

	info := &KnightIsolationInfo{
		RuntimeOptOut:    getStr(iso, "runtime") == "none",
		EgressOptOut:     getStr(iso, "egress") == "unrestricted",
		Isolated:         findCRCondition(status, condIsolated),
		EgressRestricted: findCRCondition(status, condEgressRestricted),
	}
	optedOut := info.RuntimeOptOut || info.EgressOptOut
	if optedOut {
		info.OptOutReason = getStr(iso, "reason")
	}

	switch {
	case optedOut || (info.Isolated != nil && info.Isolated.Reason == reasonIsolationOptedOut):
		info.State = isolationStateOptedOut
	case info.Isolated == nil:
		info.State = isolationStateUnknown
	case info.Isolated.Status == string(metav1.ConditionTrue):
		info.State = isolationStateIsolated
	default:
		info.State = isolationStateNotEnforced
	}
	if info.Isolated != nil {
		info.Reason = info.Isolated.Reason
		info.Message = info.Isolated.Message
	}

	// The CiliumNetworkPolicy (with hostname rules) is applied when the
	// condition is True, and also when only an allowed Service is missing.
	if er := info.EgressRestricted; er != nil && !info.EgressOptOut {
		info.HostnameRulesEnforced = er.Status == string(metav1.ConditionTrue) ||
			er.Reason == reasonFQDNPolicyApplied || er.Reason == reasonEgressServiceMissing
	}

	// Effective RuntimeClass: the pod is authoritative; otherwise the knight's
	// own setting, then its table's default.
	switch {
	case pod != nil:
		if pod.Spec.RuntimeClassName != nil {
			info.RuntimeClassName = *pod.Spec.RuntimeClassName
		}
	case info.RuntimeOptOut:
	case getStr(spec, "runtimeClassName") != "":
		info.RuntimeClassName = getStr(spec, "runtimeClassName")
	default:
		info.RuntimeClassName = getStr(tableDefaults, "runtimeClassName")
	}

	// Effective allowlist: none when egress is opted out; the knight's own
	// spec.egress, else its table's default (allowlists are not merged).
	if !info.EgressOptOut {
		if e := getNestedMap(spec, "egress"); e != nil {
			info.Egress = parseEgress(e, "knight")
		} else if e := getNestedMap(tableDefaults, "egress"); e != nil {
			info.Egress = parseEgress(e, "table")
		}
	}
	return info
}
