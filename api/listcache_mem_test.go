package main

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"runtime"
	"strings"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
)

// Memory bound of the list cache (#471).

const (
	memTestChains   = 400
	memTestKnights  = 20
	memTestSteps    = 6
	memTestOutputKB = 4
	// listCacheHeapBudget is the steady-state heap the list cache may add for
	// memTestChains Chains and memTestKnights Knights. Measured at about
	// 3 MiB with the trim (about 60 MiB without it); the budget leaves headroom
	// and still fails long before the 64 MiB target of #471.
	listCacheHeapBudget = 24 << 20
)

// bigOutput is a step output of n KiB with multi-byte runes in it.
func bigOutput(seed, n int) string {
	var b strings.Builder
	for b.Len() < n<<10 {
		fmt.Fprintf(&b, "line %d of step output, ünïcode ✓ %d\n", seed, b.Len())
	}
	return b.String()
}

func managedFields() []interface{} {
	mf := make([]interface{}, 3)
	for i := range mf {
		mf[i] = map[string]interface{}{
			"manager": "roundtable-operator", "operation": "Update", "apiVersion": "ai.roundtable.io/v1alpha1",
			"fieldsType": "FieldsV1",
			"fieldsV1":   map[string]interface{}{"f:status": map[string]interface{}{"f:stepStatuses": map[string]interface{}{".": map[string]interface{}{}}, "f:phase": map[string]interface{}{}}},
		}
	}
	return mf
}

// memTestChain is a pipeline run copy with long step, fan-out and loop outputs.
func memTestChain(i int) map[string]interface{} {
	specSteps := []interface{}{}
	statusSteps := []interface{}{}
	for s := 0; s < memTestSteps; s++ {
		name := fmt.Sprintf("step-%d", s)
		specSteps = append(specSteps, map[string]interface{}{
			"name": name, "knightRef": map[string]interface{}{"name": fmt.Sprintf("knight-%d", s%memTestKnights)},
			"task": strings.Repeat("do the thing ", 40),
		})
		st := map[string]interface{}{
			"name": name, "phase": "Succeeded", "taskId": fmt.Sprintf("t-%d-%d", i, s),
			"startedAt": "2026-11-26T10:00:00Z", "completedAt": "2026-11-26T10:05:00Z",
			"output":  bigOutput(i*10+s, memTestOutputKB),
			"costUSD": "0.12", "tokens": map[string]interface{}{"input": int64(1000), "output": int64(200)},
		}
		switch s {
		case 1:
			st["fanOut"] = map[string]interface{}{
				"total": int64(2), "succeeded": int64(2), "itemPhases": "SS",
				"items": []interface{}{
					map[string]interface{}{"index": int64(1), "phase": "Succeeded", "output": bigOutput(i, 2)},
					map[string]interface{}{"index": int64(0), "phase": "Succeeded", "output": "short"},
				},
			}
		case 2:
			st["loop"] = map[string]interface{}{
				"iteration": int64(2), "maxIterations": int64(3), "outcome": "Converged",
				"steps": []interface{}{
					map[string]interface{}{"name": "fix", "iteration": int64(2), "phase": "Succeeded", "taskId": "l2", "output": bigOutput(i, 2)},
				},
				"history": []interface{}{
					map[string]interface{}{"step": "fix", "round": int64(1), "phase": "Succeeded", "taskId": "l1", "outputSummary": "first round"},
				},
			}
		case 3:
			st["output"] = "a short output"
		case 4:
			delete(st, "output")
		}
		statusSteps = append(statusSteps, st)
	}
	return map[string]interface{}{
		"apiVersion": "ai.roundtable.io/v1alpha1",
		"kind":       "Chain",
		"metadata": map[string]interface{}{
			"name": fmt.Sprintf("pr-pipeline-run-%04d", i), "namespace": "roundtable",
			"resourceVersion": fmt.Sprint(i + 1),
			"annotations":     map[string]interface{}{runTemplateAnnotation: "pr-pipeline"},
			"managedFields":   managedFields(),
		},
		"spec": map[string]interface{}{"steps": specSteps},
		"status": map[string]interface{}{
			"phase": "Succeeded", "startedAt": "2026-11-26T10:00:00Z", "completedAt": "2026-11-26T11:00:00Z",
			"stepStatuses": statusSteps,
		},
	}
}

func memTestKnight(i int) map[string]interface{} {
	k := makeTestKnightCR(fmt.Sprintf("knight-%d", i), "roundtable", "dev").Object
	k["metadata"].(map[string]interface{})["managedFields"] = managedFields()
	return k
}

func memTestClient() *fake.FakeDynamicClient {
	objs := []k8sruntime.Object{}
	for i := 0; i < memTestChains; i++ {
		objs = append(objs, &unstructured.Unstructured{Object: memTestChain(i)})
	}
	for i := 0; i < memTestKnights; i++ {
		objs = append(objs, &unstructured.Unstructured{Object: memTestKnight(i)})
	}
	return fake.NewSimpleDynamicClientWithCustomListKinds(k8sruntime.NewScheme(),
		map[schema.GroupVersionResource]string{chainGVR: "ChainList", knightGVR: "KnightList"}, objs...)
}

func heapInUse() uint64 {
	runtime.GC()
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.HeapAlloc
}

// TestListCacheHeapBudget syncs the Chain and Knight caches and fails when
// the heap they hold exceeds listCacheHeapBudget.
func TestListCacheHeapBudget(t *testing.T) {
	t.Cleanup(resetListCache)
	client := memTestClient()
	before := heapInUse()
	chains, err := cachedList(context.Background(), client, chainGVR, "roundtable")
	if err != nil {
		t.Fatal(err)
	}
	knights, err := cachedList(context.Background(), client, knightGVR, "roundtable")
	if err != nil {
		t.Fatal(err)
	}
	if len(chains) != memTestChains || len(knights) != memTestKnights {
		t.Fatalf("got %d chains, %d knights", len(chains), len(knights))
	}
	chains, knights = nil, nil
	after := heapInUse()
	var grown uint64
	if after > before {
		grown = after - before
	}
	t.Logf("list cache heap for %d chains and %d knights: %.1f MiB (%.2f MiB per 100 chains)",
		memTestChains, memTestKnights, float64(grown)/(1<<20), float64(grown)/(1<<20)/(memTestChains/100))
	if grown > listCacheHeapBudget {
		t.Fatalf("list cache holds %.1f MiB, budget %d MiB", float64(grown)/(1<<20), listCacheHeapBudget>>20)
	}
	runtime.KeepAlive(client)
}

// TestTrimKeepsChainJSON: the slim and full list payloads of a trimmed Chain
// are byte-identical to those of the untrimmed one.
func TestTrimKeepsChainJSON(t *testing.T) {
	for i := 0; i < 3; i++ {
		orig := memTestChain(i)
		trimmed := (&unstructured.Unstructured{Object: memTestChain(i)}).DeepCopy().Object
		trimForListCache(trimmed, true)

		if _, ok := trimmed["metadata"].(map[string]interface{})["managedFields"]; ok {
			t.Fatal("managedFields kept")
		}
		out := trimmed["status"].(map[string]interface{})["stepStatuses"].([]interface{})[0].(map[string]interface{})["output"].(string)
		if len(out) != chainStepResultCut {
			t.Fatalf("step output kept %d bytes, want %d", len(out), chainStepResultCut)
		}

		a := parseChainResource(orig, nil)
		b := parseChainResource(trimmed, nil)
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("summary differs:\n%+v\n%+v", a, b)
		}
		for _, v := range [][2]interface{}{{a, b}, {slimChain(a), slimChain(b)}} {
			ja, _ := json.Marshal(v[0])
			jb, _ := json.Marshal(v[1])
			if string(ja) != string(jb) {
				t.Fatalf("JSON differs:\n%s\n%s", ja, jb)
			}
		}
		if a.Steps[1].FanOut.Items[1].OutputBytes == 0 || a.Steps[2].Loop.Rounds[1].Steps[0].OutputBytes == 0 {
			t.Fatal("test chain has no fan-out/loop outputs")
		}
	}
}

func TestTrimKnightOnlyManagedFields(t *testing.T) {
	k := memTestKnight(0)
	want := (&unstructured.Unstructured{Object: memTestKnight(0)}).DeepCopy().Object
	delete(want["metadata"].(map[string]interface{}), "managedFields")
	trimForListCache(k, false)
	if !reflect.DeepEqual(k, want) {
		t.Fatalf("knight trimmed beyond managedFields:\n%v", k)
	}
}

// TestChainCacheTrimmedDetailFull: the cached Chain is trimmed, the object
// the detail endpoint reads (direct GET) still has the full output.
func TestChainCacheTrimmedDetailFull(t *testing.T) {
	t.Cleanup(resetListCache)
	client := memTestClient()
	items, err := cachedList(context.Background(), client, chainGVR, "roundtable")
	if err != nil {
		t.Fatal(err)
	}
	step := func(o map[string]interface{}) string {
		return o["status"].(map[string]interface{})["stepStatuses"].([]interface{})[0].(map[string]interface{})["output"].(string)
	}
	if n := len(step(items[0].Object)); n != chainStepResultCut {
		t.Fatalf("cached output %d bytes", n)
	}
	full, err := client.Resource(chainGVR).Namespace("roundtable").Get(context.Background(), items[0].GetName(), metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if n := len(step(full.Object)); n < memTestOutputKB<<10 {
		t.Fatalf("direct GET output %d bytes", n)
	}
}

func TestParseCgroupMemoryLimit(t *testing.T) {
	for in, want := range map[string]int64{
		"134217728\n": 134217728, "max\n": 0, "": 0, "junk": 0, "9223372036854771712": 0, "-1": 0,
	} {
		got, ok := parseCgroupMemoryLimit(in)
		if got != want || ok != (want > 0) {
			t.Errorf("parse %q = %d, %v", in, got, ok)
		}
	}
	if got := memoryLimitFor(100 << 20); got != 90<<20 {
		t.Errorf("soft limit %d", got)
	}
}

func TestSetMemoryLimitRespectsEnv(t *testing.T) {
	t.Setenv("GOMEMLIMIT", "100MiB")
	if got := setMemoryLimitFromCgroup([]string{"/nonexistent"}); got != 0 {
		t.Fatalf("set %d despite GOMEMLIMIT", got)
	}
}
