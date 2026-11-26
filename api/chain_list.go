package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// Chain list pagination, filters and slim payload (#275).
//
// GET /api/chains returns a slim, paginated, newest-first page:
//
//	limit     page size, default 100, max 500
//	offset    chains to skip, default 0
//	phase     comma-separated phases (case-insensitive), e.g. Running,Failed
//	template  only run copies of this template (ai.roundtable.io/run-template)
//	copies    include (default) | exclude | only — run copies in the page
//	full=true the pre-#275 payload: full step detail and, unless
//	          limit/offset is given, every chain in list order
//
// The slim page keeps chain-level phase, timings, cost and tokens and only
// name and phase per step (see ChainListItem), so 100 chains stay well
// under 100 KB. X-Total-Count carries the number of chains matching the filters.
//
// GET /api/chain-groups summarises run copies per template so the UI can
// show "pr-pipeline: 150 runs, 148 succeeded" without loading every copy.

// runTemplateAnnotation marks a Chain created by issue pickup or a trigger as
// a run copy of the named template Chain (set by the operator).
const runTemplateAnnotation = "ai.roundtable.io/run-template"

const (
	defaultChainListLimit = 100
	maxChainListLimit     = 500
)

const (
	copiesInclude = "include"
	copiesExclude = "exclude"
	copiesOnly    = "only"
)

type chainListQuery struct {
	full     bool
	paged    bool // limit or offset was given
	limit    int
	offset   int
	phases   map[string]bool
	template string
	copies   string
}

// parseChainListQuery validates the list query parameters.
func parseChainListQuery(q url.Values) (chainListQuery, string) {
	lq := chainListQuery{limit: defaultChainListLimit, copies: copiesInclude}
	if v := q.Get("full"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return lq, "full must be true or false"
		}
		lq.full = b
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return lq, "limit must be a positive integer"
		}
		if n > maxChainListLimit {
			n = maxChainListLimit
		}
		lq.limit = n
		lq.paged = true
	}
	if v := q.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return lq, "offset must be a non-negative integer"
		}
		lq.offset = n
		lq.paged = true
	}
	if v := q.Get("phase"); v != "" {
		lq.phases = map[string]bool{}
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				lq.phases[strings.ToLower(p)] = true
			}
		}
	}
	if v := q.Get("template"); v != "" {
		if !validKnightName.MatchString(v) {
			return lq, "invalid template name"
		}
		lq.template = v
	}
	switch v := q.Get("copies"); v {
	case "", copiesInclude:
	case copiesExclude, copiesOnly:
		lq.copies = v
	default:
		return lq, "copies must be include, exclude or only"
	}
	return lq, ""
}

func (lq chainListQuery) matches(c *ChainSummary) bool {
	if lq.phases != nil && !lq.phases[strings.ToLower(chainPhaseOrPending(c.Phase))] {
		return false
	}
	if lq.template != "" && c.RunTemplate != lq.template {
		return false
	}
	switch lq.copies {
	case copiesExclude:
		return c.RunTemplate == ""
	case copiesOnly:
		return c.RunTemplate != ""
	}
	return true
}

// chainPhaseOrPending treats a chain without status as Pending, as the UI does.
func chainPhaseOrPending(p string) string {
	if p == "" {
		return "Pending"
	}
	return p
}

func isChainRunning(phase string) bool {
	return phase == "Running" || phase == "StepRunning"
}

// sortChainsNewestFirst orders running chains first, then by start time,
// newest first; chains that never started go last. Ties break on name.
func sortChainsNewestFirst(chains []ChainSummary) {
	sort.SliceStable(chains, func(i, j int) bool {
		a, b := &chains[i], &chains[j]
		if ra, rb := isChainRunning(a.Phase), isChainRunning(b.Phase); ra != rb {
			return ra
		}
		sa, sb := strOrEmpty(a.StartTime), strOrEmpty(b.StartTime)
		if sa != sb {
			// RFC 3339 UTC timestamps sort lexically; "" (never started) last.
			return sa > sb
		}
		return a.Name < b.Name
	})
}

func strOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ChainListStep is a step in the slim list: enough to count steps and show
// their state (~40 bytes, so a chain with 8 steps stays under 1 KB). Timings, cost and tokens are kept at chain level; everything
// else (results, errors, fan-out items, loop rounds) comes from
// GET /api/chains/{name} or the WS push when a chain is expanded.
type ChainListStep struct {
	Name  string `json:"name"`
	Phase string `json:"phase"`
}

// ChainListItem is a chain in the slim list. Its Steps field shadows the
// embedded ChainSummary.Steps in the JSON encoding.
type ChainListItem struct {
	ChainSummary
	Steps []ChainListStep `json:"steps"`
}

// slimChain reduces a summary to the slim list item.
func slimChain(c ChainSummary) ChainListItem {
	steps := make([]ChainListStep, len(c.Steps))
	for i, s := range c.Steps {
		steps[i] = ChainListStep{Name: s.Name, Phase: s.Phase}
	}
	c.Steps = nil
	c.Slim = true
	return ChainListItem{ChainSummary: c, Steps: steps}
}

// listChains applies filters, ordering, pagination and slimming. It returns
// the page ([]ChainSummary with full=true, else []ChainListItem) and the
// number of chains matching the filters.
func listChains(all []ChainSummary, lq chainListQuery) (any, int) {
	matched := make([]ChainSummary, 0, len(all))
	for i := range all {
		if lq.matches(&all[i]) {
			matched = append(matched, all[i])
		}
	}
	total := len(matched)
	if lq.full && !lq.paged {
		// Pre-#275 payload: every chain, list order, results included.
		return matched, total
	}
	sortChainsNewestFirst(matched)
	start := min(lq.offset, total)
	end := min(start+lq.limit, total)
	page := matched[start:end]
	if lq.full {
		return page, total
	}
	out := make([]ChainListItem, len(page))
	for i, c := range page {
		out[i] = slimChain(c)
	}
	return out, total
}

func chainsHandler(namespace string, running *runningRegistry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if dynClient == nil {
			jsonError(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}
		lq, msg := parseChainListQuery(r.URL.Query())
		if msg != "" {
			jsonError(w, msg, http.StatusBadRequest)
			return
		}

		items, err := cachedList(r.Context(), dynClient, chainGVR, namespace)
		if err != nil {
			slog.ErrorContext(r.Context(), "Chain list error", "error", err)
			jsonError(w, "Failed to list chains", http.StatusInternalServerError)
			return
		}

		knights := getKnightInfoMap(r.Context(), namespace)
		all := make([]ChainSummary, 0, len(items))
		filter := tableFilter(r)
		for _, item := range items {
			c := parseChainResource(item.Object, knights)
			if !tableMatches(filter, c.RoundTableRef) {
				continue
			}
			joinChainInFlight(&c, running)
			all = append(all, c)
		}
		page, total := listChains(all, lq)

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Total-Count", strconv.Itoa(total))
		json.NewEncoder(w).Encode(page)
	}
}

// ChainRunGroup summarises the run copies of one template.
type ChainRunGroup struct {
	Template string `json:"template"`
	Runs     int    `json:"runs"`
	// Phases counts the copies per phase ("" is reported as Pending).
	Phases map[string]int `json:"phases"`
	// LastStartTime is the start of the newest copy.
	LastStartTime *string `json:"lastStartTime,omitempty"`
	// TemplateExists is false when the template Chain itself is gone.
	TemplateExists bool `json:"templateExists"`
}

// chainRunGroups groups run copies by template: groups with a running copy
// first, then by newest start, then by template name.
func chainRunGroups(all []ChainSummary) []ChainRunGroup {
	names := map[string]bool{}
	byTemplate := map[string]*ChainRunGroup{}
	for i := range all {
		c := &all[i]
		names[c.Name] = true
		if c.RunTemplate == "" {
			continue
		}
		g, ok := byTemplate[c.RunTemplate]
		if !ok {
			g = &ChainRunGroup{Template: c.RunTemplate, Phases: map[string]int{}}
			byTemplate[c.RunTemplate] = g
		}
		g.Runs++
		g.Phases[chainPhaseOrPending(c.Phase)]++
		if s := strOrEmpty(c.StartTime); s != "" && s > strOrEmpty(g.LastStartTime) {
			g.LastStartTime = &s
		}
	}
	out := make([]ChainRunGroup, 0, len(byTemplate))
	for _, g := range byTemplate {
		g.TemplateExists = names[g.Template]
		out = append(out, *g)
	}
	running := func(g *ChainRunGroup) bool { return g.Phases["Running"]+g.Phases["StepRunning"] > 0 }
	sort.Slice(out, func(i, j int) bool {
		a, b := &out[i], &out[j]
		if ra, rb := running(a), running(b); ra != rb {
			return ra
		}
		if sa, sb := strOrEmpty(a.LastStartTime), strOrEmpty(b.LastStartTime); sa != sb {
			return sa > sb
		}
		return a.Template < b.Template
	})
	return out
}

func chainGroupsHandler(namespace string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if dynClient == nil {
			jsonError(w, "Kubernetes not available", http.StatusServiceUnavailable)
			return
		}
		items, err := cachedList(r.Context(), dynClient, chainGVR, namespace)
		if err != nil {
			slog.ErrorContext(r.Context(), "Chain list error", "error", err)
			jsonError(w, "Failed to list chains", http.StatusInternalServerError)
			return
		}
		all := make([]ChainSummary, 0, len(items))
		for _, item := range items {
			md := getNestedMap(item.Object, "metadata")
			all = append(all, ChainSummary{
				Name:        getStr(md, "name"),
				Phase:       getStr(getNestedMap(item.Object, "status"), "phase"),
				StartTime:   optStr(getStr(getNestedMap(item.Object, "status"), "startedAt")),
				RunTemplate: chainRunTemplate(md),
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(chainRunGroups(all))
	}
}

// chainRunTemplate reads the run-template annotation from Chain metadata.
func chainRunTemplate(metadata map[string]interface{}) string {
	v, _ := getNestedMap(metadata, "annotations")[runTemplateAnnotation].(string)
	return v
}
