package main

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"

	"k8s.io/client-go/dynamic"
)

// Cost and token totals per chain run, step and mission (#270, part of #268).
// The operator writes them to status (roundtable-k8s/roundtable#521):
// status.stepStatuses[].costUSD/tokens, status.costUSD/tokens on a Chain, and
// status.tokens plus status.chainStatuses[].costUSD/tokens on a Mission.
//
// Status does not say how a cost is billed. Subscription-billed (Claude plan)
// knights report an API-equivalent, notional cost, so the API marks a step's
// cost notional when its knight is plan-backed, using the operator's own rule
// (Knight spec.planBacked, else "runs a claude-knight image").

// TokenTotals is a sum of input and output tokens.
type TokenTotals struct {
	Input  int64 `json:"input"`
	Output int64 `json:"output"`
}

// knightInfo is what chain and mission views need to know about a knight.
type knightInfo struct {
	Domain string
	// PlanBacked: the knight spends the shared Claude plan, so its reported
	// cost is notional.
	PlanBacked bool
}

// knightInfoFromSpec reads a Knight CR's spec.
func knightInfoFromSpec(spec map[string]interface{}) knightInfo {
	info := knightInfo{Domain: getStr(spec, "domain")}
	if v, ok := spec["planBacked"].(bool); ok {
		info.PlanBacked = v
	} else {
		info.PlanBacked = isClaudeKnightImage(getStr(spec, "image"))
	}
	return info
}

// isClaudeKnightImage mirrors the operator's AgentRuntimeForImage: the image
// repository's last path segment is claude-knight or claude-knight-*.
// An unset image is the operator's default (pi-knight), so not plan-backed.
func isClaudeKnightImage(image string) bool {
	ref := image
	if i := strings.Index(ref, "@"); i >= 0 {
		ref = ref[:i]
	}
	if i := strings.LastIndex(ref, "/"); i >= 0 {
		ref = ref[i+1:]
	}
	if i := strings.Index(ref, ":"); i >= 0 {
		ref = ref[:i]
	}
	return ref == "claude-knight" || strings.HasPrefix(ref, "claude-knight-")
}

// getTokens reads a {input, output} token object; nil when absent.
func getTokens(obj map[string]interface{}, key string) *TokenTotals {
	m := getNestedMap(obj, key)
	if m == nil {
		return nil
	}
	return &TokenTotals{Input: int64(getInt(m, "input")), Output: int64(getInt(m, "output"))}
}

// parseCost reads a status cost string; ok is false when empty or malformed.
func parseCost(s string) (float64, bool) {
	if s == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

func formatCostUSD(v float64) string { return fmt.Sprintf("%.6f", v) }

func addTokenTotals(t *TokenTotals, add *TokenTotals) *TokenTotals {
	if add == nil {
		return t
	}
	if t == nil {
		t = &TokenTotals{}
	}
	t.Input += add.Input
	t.Output += add.Output
	return t
}

// applyStepCost copies a step's cost and tokens from its status entry.
func applyStepCost(step *StepSummary, sm map[string]interface{}, knights map[string]knightInfo) {
	if _, ok := parseCost(getStr(sm, "costUSD")); ok {
		step.CostUSD = getStr(sm, "costUSD")
	}
	step.Tokens = getTokens(sm, "tokens")
	if step.CostUSD != "" && step.Knight != "" {
		step.CostNotional = knights[step.Knight].PlanBacked
	}
}

// applyChainCost sets the run totals: status.costUSD/tokens when the operator
// wrote them, else the sum over the steps. notionalCostUSD is the part spent
// by plan-backed knights.
func applyChainCost(chain *ChainSummary, status map[string]interface{}) {
	var sum, notional float64
	var anyCost bool
	var tokens *TokenTotals
	for _, s := range chain.Steps {
		if v, ok := parseCost(s.CostUSD); ok {
			anyCost = true
			sum += v
			if s.CostNotional {
				notional += v
			}
		}
		tokens = addTokenTotals(tokens, s.Tokens)
	}
	if s := getStr(status, "costUSD"); s != "" {
		if _, ok := parseCost(s); ok {
			chain.CostUSD = s
		}
	} else if anyCost {
		chain.CostUSD = formatCostUSD(sum)
	}
	if t := getTokens(status, "tokens"); t != nil {
		chain.Tokens = t
	} else {
		chain.Tokens = tokens
	}
	if notional > 0 {
		chain.NotionalCostUSD = formatCostUSD(notional)
	}
}

// applyMissionNotional marks the notional part of each mission chain's cost
// (and of the mission) from the parsed Chain resources, keyed by name.
func applyMissionNotional(m *MissionSummary, chains map[string]ChainSummary) {
	var notional float64
	for i := range m.ChainStatuses {
		cs := &m.ChainStatuses[i]
		c, ok := chains[cs.ChainCRName]
		if !ok {
			continue
		}
		if v, ok := parseCost(c.NotionalCostUSD); ok && v > 0 {
			cs.NotionalCostUSD = c.NotionalCostUSD
			notional += v
		}
	}
	if notional > 0 {
		m.NotionalCostUSD = formatCostUSD(notional)
	}
}

// missionChainIndex lists the namespace's Chains (parsed, keyed by name) so
// mission views can mark notional cost. A failed list yields an empty index:
// costs then show without the notional split.
func missionChainIndex(ctx context.Context, client dynamic.Interface, namespace string) map[string]ChainSummary {
	out := map[string]ChainSummary{}
	if client == nil {
		return out
	}
	items, err := cachedList(ctx, client, chainGVR, namespace)
	if err != nil {
		return out
	}
	knights := knightInfoMap(ctx, client, namespace)
	for _, item := range items {
		out[item.GetName()] = parseChainResource(item.Object, knights)
	}
	return out
}
