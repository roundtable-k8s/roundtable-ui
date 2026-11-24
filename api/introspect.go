package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Per-pod introspection (#219).
//
// Every knight pod answers `<prefix>.introspect.<Knight>.<pod>`
// (claude-knight#18, pi-knight#64). The knight-level subject
// `<prefix>.introspect.<Knight>` has no queue group, so with N replicas the
// first of N replies wins and the dashboard shows a random pod. The session
// handler therefore talks to pods by name:
//   - with ?pod=<name> it asks exactly that pod (validated against the
//     knight's own running pods);
//   - otherwise it fans out to every ready pod and combines the replies
//     (stats are summed with a per-pod breakdown, history lists are merged
//     and tagged with their pod, session/recent/tree take the reply of the
//     first pod, in name order, that has the data).
// The knight-level subject is only used when the per-pod subject has no
// responders (older runtime) and the result cannot be a random pod, or when
// the knight's pods cannot be listed at all.

// introspectScopeHeader tells the client where the data came from:
// "pod" (one named pod), "aggregate" (fan-out over all ready pods) or
// "knight" (legacy knight-level subject).
const introspectScopeHeader = "X-Introspect-Scope"

// validRunID guards the runId forwarded to the knight (it ends up in a JSON
// payload, but keep it to the characters run ids actually use).
var validRunID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// sessionRequester returns the NATS requester used by the session handler,
// or nil when NATS is unavailable. Tests replace it.
var sessionRequester = func() introspectRequester {
	if nc == nil {
		return nil
	}
	return func(subject string, data []byte, timeout time.Duration) ([]byte, error) {
		msg, err := nc.Request(subject, data, timeout)
		if err != nil {
			return nil, err
		}
		return msg.Data, nil
	}
}

// knightPodsForIntrospect lists the knight's pods that can answer
// introspection: Running, Ready, not terminating, not CronJob pods. Sorted
// by name so every merge is deterministic.
func knightPodsForIntrospect(ctx context.Context, namespace, knight string) ([]string, error) {
	if k8sClient == nil {
		return nil, fmt.Errorf("kubernetes client not available")
	}
	pods, err := k8sClient.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("app.kubernetes.io/name=knight,app.kubernetes.io/instance=%s", knight),
	})
	if err != nil {
		return nil, err
	}
	var out []string
	for _, pod := range pods.Items {
		if _, ok := pod.Labels["job-name"]; ok {
			continue
		}
		if pod.DeletionTimestamp != nil || pod.Status.Phase != corev1.PodRunning || !podReadyCondition(&pod) {
			continue
		}
		if validPodName(pod.Name) {
			out = append(out, pod.Name)
		}
	}
	sort.Strings(out)
	return out, nil
}

func podReadyCondition(pod *corev1.Pod) bool {
	for _, c := range pod.Status.Conditions {
		if c.Type == corev1.PodReady {
			return c.Status == corev1.ConditionTrue
		}
	}
	return false
}

func isNoResponders(err error) bool {
	return errors.Is(err, nats.ErrNoResponders)
}

// podReply is one pod's answer (or failure) during a fan-out.
type podReply struct {
	Pod  string
	Data []byte
	Err  error
}

// fanOutIntrospect sends the same request to every pod's subject in
// parallel and returns the replies in pod order.
func fanOutIntrospect(req introspectRequester, prefix, knight string, pods []string, payload []byte, timeout time.Duration) []podReply {
	out := make([]podReply, len(pods))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for i, pod := range pods {
		wg.Add(1)
		go func(i int, pod string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			data, err := req(podIntrospectSubject(prefix, knight, pod), payload, timeout)
			out[i] = podReply{Pod: pod, Data: data, Err: err}
		}(i, pod)
	}
	wg.Wait()
	return out
}

func podIntrospectSubject(prefix, knight, pod string) string {
	return fmt.Sprintf("%s.introspect.%s.%s", prefix, capitalizeKnight(knight), pod)
}

func knightIntrospectSubject(prefix, knight string) string {
	return fmt.Sprintf("%s.introspect.%s", prefix, capitalizeKnight(knight))
}

// replyFound reports whether a reply carries data rather than a
// "not found"/error answer. A reply is found only if all hold:
//   - it has no error (absent, null, "" or false);
//   - it is not {"found": false};
//   - it either has "found": true or at least one key other than
//     "error" and "found" (so {} and {"error": null} carry nothing).
//
// {"sessions": []} is therefore found: an empty list is still data.
func replyFound(data []byte) bool {
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return false
	}
	if e, ok := m["error"]; ok && e != nil && e != "" && e != false {
		return false
	}
	if f, ok := m["found"].(bool); ok && !f {
		return false
	}
	if f, ok := m["found"].(bool); ok && f {
		return true
	}
	for k := range m {
		if k != "error" && k != "found" {
			return true
		}
	}
	return false
}

// pickFirstFound returns the first reply (pod order) that has the data; if
// none has it, the first reply that answered at all (so the knight's own
// "not found" is passed through). ok is false when no pod answered.
func pickFirstFound(replies []podReply) (podReply, bool) {
	var firstAnswer *podReply
	for i := range replies {
		r := replies[i]
		if r.Err != nil {
			continue
		}
		if replyFound(r.Data) {
			return r, true
		}
		if firstAnswer == nil {
			firstAnswer = &replies[i]
		}
	}
	if firstAnswer != nil {
		return *firstAnswer, true
	}
	return podReply{}, false
}

// allNoResponders reports whether every pod failed because nobody listens on
// its per-pod subject (an older runtime that only has the knight subject).
func allNoResponders(replies []podReply) bool {
	if len(replies) == 0 {
		return false
	}
	for _, r := range replies {
		if r.Err == nil || !isNoResponders(r.Err) {
			return false
		}
	}
	return true
}

// podBreakdown is one entry of the per-pod breakdown.
type podBreakdown struct {
	Pod   string                 `json:"pod"`
	OK    bool                   `json:"ok"`
	Error string                 `json:"error,omitempty"`
	Stats map[string]interface{} `json:"stats,omitempty"`
}

func replyError(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, nats.ErrTimeout), errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case isNoResponders(err):
		return "no responders"
	default:
		return "request failed"
	}
}

// maxStatKeys are numeric stats where the knight total is the largest pod
// value, not the sum (times and timestamps).
var maxStatKeys = map[string]bool{
	"uptime": true, "uptimeSeconds": true, "uptimeMs": true,
	"startedAt": true, "lastActivity": true, "lastActivityAt": true, "timestamp": true,
}

// aggregateStats combines the stats replies of all pods into knight totals:
// numbers are summed (uptime and timestamps take the max), nested objects are
// merged recursively, lists are concatenated with each item tagged with its
// pod, strings keep the first pod's value and booleans are OR-ed. The
// original per-pod replies are kept under "pods"; pods that did not answer
// are listed with their error, so a partial timeout still yields the totals
// of the pods that answered.
func aggregateStats(knight string, replies []podReply) (map[string]interface{}, bool) {
	agg := map[string]interface{}{}
	breakdown := make([]podBreakdown, 0, len(replies))
	answered := 0
	for _, r := range replies {
		if r.Err != nil {
			breakdown = append(breakdown, podBreakdown{Pod: r.Pod, Error: replyError(r.Err)})
			continue
		}
		var m map[string]interface{}
		if err := json.Unmarshal(r.Data, &m); err != nil {
			breakdown = append(breakdown, podBreakdown{Pod: r.Pod, Error: "invalid reply"})
			continue
		}
		answered++
		breakdown = append(breakdown, podBreakdown{Pod: r.Pod, OK: true, Stats: m})
		for k, v := range m {
			if k == "pod" || k == "node" || k == "pods" {
				continue
			}
			if list, ok := v.([]interface{}); ok {
				v = tagListWithPod(list, r.Pod)
			}
			agg[k] = mergeStatValue(agg[k], cloneJSON(v), k)
		}
	}
	if answered == 0 {
		return nil, false
	}
	if _, ok := agg["knight"]; !ok {
		agg["knight"] = knight
	}
	agg["pods"] = breakdown
	agg["podCount"] = len(replies)
	agg["respondedPods"] = answered
	return agg, true
}

func mergeStatValue(a, b interface{}, key string) interface{} {
	if a == nil {
		return b
	}
	if b == nil {
		return a
	}
	switch av := a.(type) {
	case float64:
		if bv, ok := b.(float64); ok {
			if maxStatKeys[key] {
				if bv > av {
					return bv
				}
				return av
			}
			return av + bv
		}
	case map[string]interface{}:
		if bv, ok := b.(map[string]interface{}); ok {
			for k, v := range bv {
				av[k] = mergeStatValue(av[k], v, k)
			}
			return av
		}
	case []interface{}:
		if bv, ok := b.([]interface{}); ok {
			return append(av, bv...)
		}
	case string:
		if av == "" {
			return b
		}
	case bool:
		if bv, ok := b.(bool); ok {
			return av || bv
		}
	}
	return a
}

// tagListWithPod returns a copy of list where every object item without a
// "pod" field gets the pod it came from.
func tagListWithPod(list []interface{}, pod string) []interface{} {
	out := make([]interface{}, len(list))
	for i, item := range list {
		if m, ok := item.(map[string]interface{}); ok {
			c := make(map[string]interface{}, len(m)+1)
			for k, v := range m {
				c[k] = v
			}
			if _, has := c["pod"]; !has {
				c["pod"] = pod
			}
			out[i] = c
			continue
		}
		out[i] = item
	}
	return out
}

// cloneJSON deep-copies a decoded JSON value so merging never mutates the
// per-pod breakdown.
func cloneJSON(v interface{}) interface{} {
	switch t := v.(type) {
	case map[string]interface{}:
		c := make(map[string]interface{}, len(t))
		for k, x := range t {
			c[k] = cloneJSON(x)
		}
		return c
	case []interface{}:
		c := make([]interface{}, len(t))
		for i, x := range t {
			c[i] = cloneJSON(x)
		}
		return c
	default:
		return v
	}
}

// mergeHistory concatenates the pods' session lists, tags each row with the
// pod it lives on and sorts newest first.
func mergeHistory(replies []podReply) (map[string]interface{}, bool) {
	sessions := []interface{}{}
	breakdown := make([]podBreakdown, 0, len(replies))
	answered := 0
	for _, r := range replies {
		if r.Err != nil {
			breakdown = append(breakdown, podBreakdown{Pod: r.Pod, Error: replyError(r.Err)})
			continue
		}
		var m struct {
			Pod      string        `json:"pod"`
			Sessions []interface{} `json:"sessions"`
		}
		if err := json.Unmarshal(r.Data, &m); err != nil {
			breakdown = append(breakdown, podBreakdown{Pod: r.Pod, Error: "invalid reply"})
			continue
		}
		answered++
		breakdown = append(breakdown, podBreakdown{Pod: r.Pod, OK: true})
		sessions = append(sessions, tagListWithPod(m.Sessions, r.Pod)...)
	}
	if answered == 0 {
		return nil, false
	}
	sort.SliceStable(sessions, func(i, j int) bool {
		return startedAtOf(sessions[i]) > startedAtOf(sessions[j])
	})
	return map[string]interface{}{
		"sessions":      sessions,
		"pods":          breakdown,
		"podCount":      len(replies),
		"respondedPods": answered,
	}, true
}

func startedAtOf(v interface{}) string {
	if m, ok := v.(map[string]interface{}); ok {
		if s, ok := m["startedAt"].(string); ok {
			return s
		}
	}
	return ""
}

// withPod adds "pod" to a JSON object reply that lacks it, so the client
// always knows which pod answered. Non-object replies pass through.
func withPod(data []byte, pod string) []byte {
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil || m == nil {
		return data
	}
	if _, ok := m["pod"]; ok {
		return data
	}
	m["pod"] = pod
	out, err := json.Marshal(m)
	if err != nil {
		return data
	}
	return out
}

// knightPodSuffixRE is the Deployment pod suffix shape: <rs-hash>-<pod-hash>.
var knightPodSuffixRE = regexp.MustCompile(`^[a-z0-9]{5,10}-[a-z0-9]{5}$`)

// looksLikeKnightPod reports whether pod is named like one of knight's
// Deployment pods (<knight>-<rs-hash>-<pod-hash>). The remainder after the
// knight prefix must have exactly that shape, so a pod of knight "foo-bar"
// (foo-bar-<rs-hash>-<pod-hash>) is not taken for one of knight "foo". It
// only picks the error shape for a pod that is not currently ready (a
// scaled-away pod no longer exists in the cluster, so the name is all there
// is to go on); it never grants access.
func looksLikeKnightPod(knight, pod string) bool {
	rest, ok := strings.CutPrefix(pod, strings.ToLower(knight)+"-")
	return ok && knightPodSuffixRE.MatchString(rest)
}

// writePodGone answers a request for a pod that no longer serves
// introspection with 410 and a machine-readable body, so the dashboard can
// show "pod gone" instead of a spinner.
func writePodGone(w http.ResponseWriter, pod string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusGone)
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"error":   "pod gone",
		"podGone": true,
		"pod":     pod,
	})
}
