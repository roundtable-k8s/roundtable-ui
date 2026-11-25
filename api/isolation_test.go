package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func cond(t, status, reason, msg string) map[string]interface{} {
	return map[string]interface{}{"type": t, "status": status, "reason": reason, "message": msg}
}

// isoKnight builds a Knight CR with the given spec fields and conditions.
func isoKnight(name string, spec map[string]interface{}, conds ...map[string]interface{}) *unstructured.Unstructured {
	cr := makeTestKnightCR(name, "test-namespace", "coding")
	s := cr.Object["spec"].(map[string]interface{})
	for k, v := range spec {
		s[k] = v
	}
	list := make([]interface{}, 0, len(conds))
	for _, c := range conds {
		list = append(list, c)
	}
	cr.Object["status"].(map[string]interface{})["conditions"] = list
	return cr
}

func isolatedKnight(name string) *unstructured.Unstructured {
	return isoKnight(name, map[string]interface{}{
		"runtimeClassName": "gvisor",
		"egress": map[string]interface{}{
			"allowedHosts": []interface{}{"api.anthropic.com", "*.github.com"},
			"allowedPorts": []interface{}{int64(443)},
			"allowedServices": []interface{}{
				map[string]interface{}{"name": "nats", "namespace": "nats", "ports": []interface{}{int64(4222)}},
			},
		},
	},
		cond("Isolated", "True", "Isolated", `RuntimeClass "gvisor" applies; hostname rules applied`),
		cond("EgressRestricted", "True", "FQDNPolicyApplied", "hostname rules applied"),
	)
}

func optedOutKnight(name string) *unstructured.Unstructured {
	return isoKnight(name, map[string]interface{}{
		"isolation": map[string]interface{}{"egress": "unrestricted", "reason": "scrapes arbitrary sites"},
		"egress":    map[string]interface{}{"allowedHosts": []interface{}{"ignored.example.com"}},
	},
		cond("Isolated", "False", "OptedOut", "Knight opts out of isolation (egress: unrestricted): scrapes arbitrary sites"),
	)
}

func TestBuildKnightIsolationIsolated(t *testing.T) {
	info := buildKnightIsolation(isolatedKnight("galahad"), nil, nil)
	if info.State != isolationStateIsolated {
		t.Fatalf("state = %q, want isolated", info.State)
	}
	if !info.HostnameRulesEnforced {
		t.Error("hostname rules should be enforced")
	}
	if info.RuntimeClassName != "gvisor" {
		t.Errorf("runtimeClassName = %q", info.RuntimeClassName)
	}
	if info.Egress == nil || info.Egress.Source != "knight" {
		t.Fatalf("egress = %+v", info.Egress)
	}
	if !reflect.DeepEqual(info.Egress.AllowedHosts, []string{"api.anthropic.com", "*.github.com"}) {
		t.Errorf("hosts = %v", info.Egress.AllowedHosts)
	}
	if !reflect.DeepEqual(info.Egress.AllowedPorts, []int32{443}) {
		t.Errorf("ports = %v", info.Egress.AllowedPorts)
	}
	want := []EgressServiceInfo{{Name: "nats", Namespace: "nats", Ports: []int32{4222}}}
	if !reflect.DeepEqual(info.Egress.AllowedServices, want) {
		t.Errorf("services = %+v", info.Egress.AllowedServices)
	}
	if info.Isolated == nil || info.EgressRestricted == nil || info.EgressRestricted.Reason != "FQDNPolicyApplied" {
		t.Errorf("conditions = %+v / %+v", info.Isolated, info.EgressRestricted)
	}
}

func TestBuildKnightIsolationOptedOut(t *testing.T) {
	info := buildKnightIsolation(optedOutKnight("kay"), nil, nil)
	if info.State != isolationStateOptedOut {
		t.Fatalf("state = %q, want opted-out", info.State)
	}
	if !info.EgressOptOut || info.RuntimeOptOut {
		t.Errorf("opt-outs = runtime %v egress %v", info.RuntimeOptOut, info.EgressOptOut)
	}
	if info.OptOutReason != "scrapes arbitrary sites" {
		t.Errorf("optOutReason = %q", info.OptOutReason)
	}
	if info.Egress != nil {
		t.Errorf("an unrestricted knight has no allowlist, got %+v", info.Egress)
	}
	if info.HostnameRulesEnforced {
		t.Error("hostname rules are not enforced for an unrestricted knight")
	}
}

func TestBuildKnightIsolationNotEnforced(t *testing.T) {
	cr := isoKnight("tristan", nil,
		cond("Isolated", "False", "FQDNPolicyUnavailable", "no CiliumNetworkPolicy API"),
		cond("EgressRestricted", "False", "FQDNPolicyUnavailable", "no CiliumNetworkPolicy API"),
	)
	defaults := map[string]interface{}{
		"runtimeClassName": "kata",
		"egress":           map[string]interface{}{"allowedHosts": []interface{}{"pypi.org"}},
	}
	info := buildKnightIsolation(cr, nil, defaults)
	if info.State != isolationStateNotEnforced {
		t.Fatalf("state = %q, want not-enforced", info.State)
	}
	if info.HostnameRulesEnforced {
		t.Error("FQDNPolicyUnavailable must not count as enforced")
	}
	if info.Reason != "FQDNPolicyUnavailable" {
		t.Errorf("reason = %q", info.Reason)
	}
	if info.RuntimeClassName != "kata" {
		t.Errorf("runtimeClassName from table default = %q", info.RuntimeClassName)
	}
	if info.Egress == nil || info.Egress.Source != "table" || !reflect.DeepEqual(info.Egress.AllowedHosts, []string{"pypi.org"}) {
		t.Errorf("egress = %+v", info.Egress)
	}
}

func TestBuildKnightIsolationUnknownAndPodRuntimeClass(t *testing.T) {
	cr := isoKnight("bedivere", map[string]interface{}{"runtimeClassName": "gvisor"})
	pod := makeTestPod("bedivere-a", "test-namespace", "bedivere", true, 0, time.Hour)
	rc := "kata"
	pod.Spec.RuntimeClassName = &rc
	info := buildKnightIsolation(cr, pod, nil)
	if info.State != isolationStateUnknown {
		t.Errorf("state = %q, want unknown without an Isolated condition", info.State)
	}
	if info.RuntimeClassName != "kata" {
		t.Errorf("the pod's RuntimeClass is authoritative, got %q", info.RuntimeClassName)
	}
}

func TestFleetAndKnightHandlersIncludeIsolation(t *testing.T) {
	router := setupTestRouter()
	ns := "test-namespace"
	tableKnight := isoKnight("tristan", nil,
		cond("Isolated", "False", "FQDNPolicyUnavailable", "no CiliumNetworkPolicy API"),
		cond("EgressRestricted", "False", "FQDNPolicyUnavailable", "no CiliumNetworkPolicy API"),
	)
	tableKnight.SetLabels(map[string]string{labelRoundTable: "dev"})
	table := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "ai.roundtable.io/v1alpha1",
		"kind":       "RoundTable",
		"metadata":   map[string]interface{}{"name": "dev", "namespace": ns},
		"spec": map[string]interface{}{"defaults": map[string]interface{}{
			"egress": map[string]interface{}{"allowedHosts": []interface{}{"pypi.org"}, "allowedPorts": []interface{}{int64(443)}},
		}},
	}}
	for _, obj := range []*unstructured.Unstructured{isolatedKnight("galahad"), optedOutKnight("kay"), tableKnight} {
		if _, err := dynClient.Resource(knightGVR).Namespace(ns).Create(nil, obj, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := dynClient.Resource(roundTableGVR).Namespace(ns).Create(nil, table, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/fleet", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var knights []KnightStatus
	if err := json.Unmarshal(w.Body.Bytes(), &knights); err != nil {
		t.Fatal(err)
	}
	got := map[string]*KnightIsolationInfo{}
	for _, k := range knights {
		got[k.Name] = k.Isolation
	}
	if got["galahad"] == nil || got["galahad"].State != isolationStateIsolated || len(got["galahad"].Egress.AllowedHosts) != 2 {
		t.Errorf("galahad isolation = %+v", got["galahad"])
	}
	if got["kay"] == nil || got["kay"].State != isolationStateOptedOut || got["kay"].OptOutReason != "scrapes arbitrary sites" {
		t.Errorf("kay isolation = %+v", got["kay"])
	}
	if got["tristan"] == nil || got["tristan"].State != isolationStateNotEnforced ||
		got["tristan"].Egress == nil || got["tristan"].Egress.Source != "table" {
		t.Errorf("tristan isolation = %+v", got["tristan"])
	}

	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/fleet/tristan", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var detail KnightDetail
	if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Isolation == nil || detail.Isolation.Egress == nil ||
		!reflect.DeepEqual(detail.Isolation.Egress.AllowedHosts, []string{"pypi.org"}) ||
		detail.Isolation.EgressRestricted == nil || detail.Isolation.EgressRestricted.Reason != "FQDNPolicyUnavailable" {
		t.Errorf("detail isolation = %+v", detail.Isolation)
	}
}
