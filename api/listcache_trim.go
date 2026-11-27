package main

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// Memory bound of the list cache (#471). The informers behind cachedList
// keep every object of a namespace in memory; Chains carry long step outputs
// in status that the list endpoints never serve in full. trimForListCache
// runs as the informer transform, before an object is stored, and drops what
// no cached reader needs:
//
//   - metadata.managedFields of every object (never served);
//   - status.stepStatuses[].output of a Chain, cut to the first
//     chainStepResultCut bytes: the list views only show the first 500 bytes
//     plus "..." (parseChainResource), which a 501-byte prefix reproduces
//     exactly;
//   - the output of fan-out items and loop body steps, which the list views
//     only measure (OutputBytes): replaced by its length in trimmedOutputLenKey.
//
// The chain detail endpoint reads the Chain with a direct GET, so it still
// returns the full outputs.

// chainStepResultCut keeps one byte more than the 500-byte list preview so
// parseChainResource still sees an over-long output and appends "...".
const chainStepResultCut = 501

// trimmedOutputLenKey holds the byte length of an output the cache dropped.
const trimmedOutputLenKey = "x-roundtable-ui-outputBytes"

// listCacheTransform returns the informer transform for gvr.
func listCacheTransform(isChain bool) func(interface{}) (interface{}, error) {
	return func(obj interface{}) (interface{}, error) {
		u, ok := obj.(*unstructured.Unstructured)
		if !ok {
			return obj, nil
		}
		trimForListCache(u.Object, isChain)
		return u, nil
	}
}

// trimForListCache trims obj in place (see the file comment).
func trimForListCache(obj map[string]interface{}, isChain bool) {
	if md, ok := obj["metadata"].(map[string]interface{}); ok {
		delete(md, "managedFields")
	}
	if !isChain {
		return
	}
	status, _ := obj["status"].(map[string]interface{})
	steps, _ := status["stepStatuses"].([]interface{})
	for _, s := range steps {
		sm, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		if out, ok := sm["output"].(string); ok && len(out) > chainStepResultCut {
			sm["output"] = cutCopy(out, chainStepResultCut)
		}
		if fo, ok := sm["fanOut"].(map[string]interface{}); ok {
			dropOutputs(fo["items"])
		}
		if lp, ok := sm["loop"].(map[string]interface{}); ok {
			dropOutputs(lp["steps"])
		}
	}
}

// cutCopy returns the first n bytes of s, copied so the long original can be
// freed. It cuts at a byte boundary like the list preview (r[:500]) does, so
// the preview stays byte-identical.
func cutCopy(s string, n int) string {
	return string([]byte(s[:n]))
}

// dropOutputs replaces the output of each entry of list with its length.
func dropOutputs(list interface{}) {
	items, _ := list.([]interface{})
	for _, it := range items {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		if out, ok := m["output"].(string); ok {
			delete(m, "output")
			m[trimmedOutputLenKey] = int64(len(out))
		}
	}
}

// outputLen is the byte length of m's output, also when the list cache
// replaced it with its length.
func outputLen(m map[string]interface{}) int {
	if out, ok := m["output"].(string); ok {
		return len(out)
	}
	return getInt(m, trimmedOutputLenKey)
}
