package main

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
)

// TestSmokeUIAndRouter serves the built UI bundle (api/static, produced by
// `cd ui && npm run build`) through the real router, with fake Kubernetes
// clients and no NATS. It skips when the bundle has not been built, so
// `go test ./...` stays green without a UI build.
func TestSmokeUIAndRouter(t *testing.T) {
	builtDir, err := filepath.Abs("static")
	if err != nil {
		t.Fatal(err)
	}
	indexBytes, err := os.ReadFile(filepath.Join(builtDir, "index.html"))
	if err != nil {
		t.Skip("api/static/index.html not found; run `cd ui && npm run build` first")
	}

	// buildRouter serves the bundle from the fixed relative path ./static, so
	// run from a temp directory whose static entry links to the built bundle.
	t.Chdir(t.TempDir())
	if err := os.Symlink(builtDir, "static"); err != nil {
		t.Fatal(err)
	}

	const ns = "smoke-ns"
	oldDyn, oldK8s := dynClient, k8sClient
	t.Cleanup(func() {
		dynClient, k8sClient = oldDyn, oldK8s
		resetListCache()
	})
	resetListCache()
	k8sClient = k8sfake.NewSimpleClientset()
	dynClient = fake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{
			missionGVR:    "MissionList",
			chainGVR:      "ChainList",
			roundTableGVR: "RoundTableList",
			knightGVR:     "KnightList",
			triggerGVR:    "TriggerList",
		})
	seed := func(gvr schema.GroupVersionResource, kind, name string, spec, status map[string]any) {
		t.Helper()
		obj := &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       kind,
			"metadata":   map[string]any{"name": name, "namespace": ns},
			"spec":       spec,
			"status":     status,
		}}
		if _, err := dynClient.Resource(gvr).Namespace(ns).Create(context.Background(), obj, metav1.CreateOptions{}); err != nil {
			t.Fatalf("seed %s %s: %v", kind, name, err)
		}
	}
	seed(roundTableGVR, "RoundTable", "table-a",
		map[string]any{"nats": map[string]any{"subjectPrefix": "fleet-a"}},
		map[string]any{"phase": "Ready"})
	seed(knightGVR, "Knight", "galahad", map[string]any{"domain": "build"}, map[string]any{"phase": "Ready"})
	seed(knightGVR, "Knight", "lancelot", map[string]any{"domain": "plan"}, map[string]any{"phase": "Ready"})
	seed(missionGVR, "Mission", "smoke-mission", map[string]any{
		"objective":     "smoke",
		"costBudgetUSD": "10.00",
		"roundTableRef": map[string]any{"name": "table-a"},
	}, map[string]any{"phase": "Running", "totalCost": "1.00"})
	seed(chainGVR, "Chain", "smoke-chain", map[string]any{
		"steps": []any{map[string]any{"name": "plan", "knightRef": map[string]any{"name": "lancelot"}, "task": "plan"}},
	}, map[string]any{"phase": "Succeeded"})

	router := buildRouter(routerDeps{
		namespace:     ns,
		fleetPrefix:   "fleet-a",
		vaultPath:     t.TempDir(),
		tables:        newTableSource(ns, "", ""),
		running:       newRunningRegistry(100, time.Minute),
		gateway:       &gatewayClient{http: http.DefaultClient},
		dispatchLimit: newDispatchLimiter(),
	})
	srv := httptest.NewServer(router)
	t.Cleanup(srv.Close)

	get := func(path string) (int, http.Header, []byte) {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		return resp.StatusCode, resp.Header, body
	}
	getJSON := func(path string, want int, out any) {
		t.Helper()
		code, hdr, body := get(path)
		if code != want {
			t.Fatalf("GET %s: status %d, want %d (body %s)", path, code, want, body)
		}
		if ct := hdr.Get("Content-Type"); mediaType(ct) != "application/json" {
			t.Fatalf("GET %s: Content-Type %q, want application/json", path, ct)
		}
		if out != nil {
			if err := json.Unmarshal(body, out); err != nil {
				t.Fatalf("GET %s: invalid JSON %s: %v", path, body, err)
			}
		}
	}

	// The shell and every hashed asset it references.
	code, hdr, body := get("/")
	if code != http.StatusOK || string(body) != string(indexBytes) {
		t.Fatalf("GET /: status %d, body does not match api/static/index.html", code)
	}
	if cc := hdr.Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("GET /: Cache-Control %q, want no-cache", cc)
	}
	assetRe := regexp.MustCompile(`(?:src|href)="(/assets/[^"]+\.(?:js|css))"`)
	assets := assetRe.FindAllSubmatch(indexBytes, -1)
	if len(assets) == 0 {
		t.Fatal("api/static/index.html references no /assets/*.js or *.css")
	}
	for _, m := range assets {
		path := string(m[1])
		code, hdr, _ := get(path)
		if code != http.StatusOK {
			t.Errorf("GET %s: status %d, want 200", path, code)
			continue
		}
		if cc := hdr.Get("Cache-Control"); cc != "public, max-age=31536000, immutable" {
			t.Errorf("GET %s: Cache-Control %q, want immutable", path, cc)
		}
	}

	// Client-side routes fall back to the shell.
	for _, path := range []string{"/fleet", "/missions/x"} {
		code, _, body := get(path)
		if code != http.StatusOK || string(body) != string(indexBytes) {
			t.Errorf("GET %s: status %d, want the index shell", path, code)
		}
	}

	// JSON the pages depend on. Items are decoded generically and the keys the
	// UI types (Knight, Mission, RoundTable, Chain) require are asserted, so a
	// renamed API field fails here. Keys typed `| null` must be present.
	listOf := func(path string, wantLen int, required []string) []map[string]any {
		t.Helper()
		var items []map[string]any
		getJSON(path, http.StatusOK, &items)
		if len(items) != wantLen {
			t.Fatalf("%s: %d items, want %d", path, len(items), wantLen)
		}
		for _, item := range items {
			requireKeys(t, path, item, required)
		}
		return items
	}
	listOf("/api/fleet", 2, []string{"name", "domain", "status", "ready", "restarts", "age", "image", "skills", "nixTools", "labels"})
	missions := listOf("/api/missions", 1, []string{"name", "namespace", "phase", "objective", "startedAt", "expiresAt",
		"knights", "chains", "costBudgetUSD", "totalCost", "ttlSeconds", "timeoutSeconds", "roundTableRef"})
	if missions[0]["name"] != "smoke-mission" {
		t.Errorf("/api/missions name = %v, want smoke-mission", missions[0]["name"])
	}
	listOf("/api/roundtables", 1, []string{"name", "namespace", "phase", "knightsReady", "knightsTotal", "natsPrefix", "costBudgetUSD", "totalCost"})
	chains := listOf("/api/chains", 1, []string{"name", "namespace", "phase", "currentStep", "startTime", "completionTime", "steps"})
	if chains[0]["name"] != "smoke-chain" {
		t.Errorf("/api/chains name = %v, want smoke-chain", chains[0]["name"])
	}

	var tables struct {
		Tables []struct {
			Name string `json:"name"`
		} `json:"tables"`
	}
	getJSON("/api/tables", http.StatusOK, &tables)
	if len(tables.Tables) != 1 || tables.Tables[0].Name != "table-a" {
		t.Errorf("/api/tables = %+v, want one table-a", tables.Tables)
	}

	var triggers []json.RawMessage
	getJSON("/api/triggers", http.StatusOK, &triggers)
	if triggers == nil {
		t.Error("/api/triggers: want a JSON array, got null")
	}

	var config map[string]any
	getJSON("/api/config", http.StatusOK, &config)

	// No NATS connection: the queues endpoint answers 503 with a JSON error.
	var queueErr struct {
		Error string `json:"error"`
	}
	getJSON("/api/queues", http.StatusServiceUnavailable, &queueErr)
	if queueErr.Error == "" {
		t.Error("/api/queues: 503 without a JSON error message")
	}

	var health map[string]string
	getJSON("/api/health", http.StatusOK, &health)
	if health["status"] != "ok" {
		t.Errorf("/api/health = %v, want status ok", health)
	}
}

// mediaType strips parameters such as "; charset=utf-8" from a Content-Type.
func mediaType(ct string) string {
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return ct
	}
	return mt
}

// requireKeys fails the test for each key missing from item. A key whose value
// is null still counts as present.
func requireKeys(t *testing.T, path string, item map[string]any, keys []string) {
	t.Helper()
	for _, k := range keys {
		if _, ok := item[k]; !ok {
			t.Errorf("%s: item %v missing key %q the UI expects", path, item["name"], k)
		}
	}
}
