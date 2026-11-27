package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/fake"
	k8sfake "k8s.io/client-go/kubernetes/fake"
)

// Global variable to hold fake client for tests
var fakeK8sClient *k8sfake.Clientset

// setupTestRouter creates a test router with mocked dependencies
func setupTestRouter() *mux.Router {
	// Initialize mock K8s client and inject it into the handlers' global
	fakeK8sClient = k8sfake.NewSimpleClientset()
	k8sClient = fakeK8sClient

	// Initialize mock dynamic client with proper scheme
	scheme := runtime.NewScheme()

	// Register our custom resource types with the scheme
	missionList := &unstructured.UnstructuredList{}
	missionList.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "ai.roundtable.io",
		Version: "v1alpha1",
		Kind:    "MissionList",
	})

	chainList := &unstructured.UnstructuredList{}
	chainList.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "ai.roundtable.io",
		Version: "v1alpha1",
		Kind:    "ChainList",
	})

	roundTableList := &unstructured.UnstructuredList{}
	roundTableList.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "ai.roundtable.io",
		Version: "v1alpha1",
		Kind:    "RoundTableList",
	})

	knightList := &unstructured.UnstructuredList{}
	knightList.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "ai.roundtable.io",
		Version: "v1alpha1",
		Kind:    "KnightList",
	})

	dynClient = fake.NewSimpleDynamicClientWithCustomListKinds(scheme,
		map[schema.GroupVersionResource]string{
			missionGVR:    "MissionList",
			chainGVR:      "ChainList",
			roundTableGVR: "RoundTableList",
			knightGVR:     "KnightList",
		})

	// Same route table as main(), without the middleware
	return buildRouter(routerDeps{
		namespace:     "test-namespace",
		fleetPrefix:   "fleet-a",
		vaultPath:     "/vault",
		gateway:       &gatewayClient{http: http.DefaultClient},
		dispatchLimit: newDispatchLimiter(),
	})
}

// makeTestKnightCR builds a minimal Knight CR for handler tests.
func makeTestKnightCR(name, namespace, domain string) *unstructured.Unstructured {
	knight := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "Knight",
			"metadata": map[string]interface{}{
				"name":      name,
				"namespace": namespace,
			},
			"spec": map[string]interface{}{
				"domain": domain,
			},
			"status": map[string]interface{}{
				"phase": "Ready",
			},
		},
	}
	knight.SetCreationTimestamp(metav1.Now())
	return knight
}

// TestHealthEndpoint tests the /api/health endpoint
func TestHealthEndpoint(t *testing.T) {
	router := setupTestRouter()

	tests := []struct {
		name           string
		method         string
		expectedStatus int
		expectedBody   map[string]string
	}{
		{
			name:           "GET /api/health returns 200",
			method:         "GET",
			expectedStatus: http.StatusOK,
			expectedBody:   map[string]string{"status": "ok"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(tt.method, "/api/health", nil)
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, w.Code)
			}

			var response map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatalf("failed to parse response: %v", err)
			}

			if response["status"] != tt.expectedBody["status"] {
				t.Errorf("expected status %s, got %s", tt.expectedBody["status"], response["status"])
			}
		})
	}
}

// TestConfigEndpoint tests the /api/config endpoint
func TestConfigEndpoint(t *testing.T) {
	router := setupTestRouter()

	req := httptest.NewRequest("GET", "/api/config", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var response map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if response["fleetPrefix"] != "fleet-a" {
		t.Errorf("expected fleetPrefix 'fleet-a', got '%s'", response["fleetPrefix"])
	}
}

// TestFleetHandler tests the /api/fleet endpoint
func TestFleetHandler(t *testing.T) {
	router := setupTestRouter()

	// Create test pods
	namespace := "test-namespace"
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "galahad-abc123",
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":     "knight",
				"app.kubernetes.io/instance": "galahad",
				"roundtable.io/domain":       "security",
			},
			CreationTimestamp: metav1.Time{Time: time.Now().Add(-1 * time.Hour)},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "knight",
					Image: "ghcr.io/roundtable-k8s/knight:latest",
				},
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{
				{
					Name:         "knight",
					Image:        "ghcr.io/roundtable-k8s/knight:latest",
					Ready:        true,
					RestartCount: 0,
				},
			},
		},
	}

	_, err := fakeK8sClient.CoreV1().Pods(namespace).Create(nil, pod, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create test pod: %v", err)
	}

	// The fleet handler is driven by Knight CRs — pods only enrich them
	_, err = dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, makeTestKnightCR("galahad", namespace, "security"), metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/fleet", nil)
	w := httptest.NewRecorder()

	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var knights []KnightStatus
	if err := json.Unmarshal(w.Body.Bytes(), &knights); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if len(knights) != 1 {
		t.Errorf("expected 1 knight, got %d", len(knights))
	}

	if knights[0].Name != "galahad" {
		t.Errorf("expected knight name 'galahad', got '%s'", knights[0].Name)
	}

	if knights[0].Domain != "security" {
		t.Errorf("expected domain 'security', got '%s'", knights[0].Domain)
	}

	if knights[0].Status != "online" {
		t.Errorf("expected status 'online', got '%s'", knights[0].Status)
	}
}

// TestFleetHandlerFiltersOutCronJobs tests that CronJob pods are excluded
func TestFleetHandlerFiltersOutCronJobs(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	// Create a CronJob pod (should be filtered out)
	cronPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "scheduled-task-12345",
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name": "knight",
				"job-name":               "scheduled-task",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "knight"}},
		},
	}

	_, err := fakeK8sClient.CoreV1().Pods(namespace).Create(nil, cronPod, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create test pod: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/fleet", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var knights []KnightStatus
	json.Unmarshal(w.Body.Bytes(), &knights)

	// Should be empty because CronJob pods are filtered
	if len(knights) != 0 {
		t.Errorf("expected 0 knights (CronJob filtered), got %d", len(knights))
	}
}

// TestKnightHandler tests the /api/fleet/{knight} endpoint
func TestKnightHandler(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "tristan-xyz789",
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":     "knight",
				"app.kubernetes.io/instance": "tristan",
				"roundtable.io/domain":       "infrastructure",
			},
			CreationTimestamp: metav1.Time{Time: time.Now()},
		},
		Spec: corev1.PodSpec{
			NodeName: "node-1",
			Containers: []corev1.Container{
				{Name: "knight", Image: "knight:v1"},
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{
				{
					Name:    "knight",
					Image:   "knight:v1",
					Ready:   true,
					Started: boolPtr(true),
					State: corev1.ContainerState{
						Running: &corev1.ContainerStateRunning{},
					},
				},
			},
			Conditions: []corev1.PodCondition{
				{Type: corev1.PodReady, Status: corev1.ConditionTrue},
			},
		},
	}

	fakeK8sClient.CoreV1().Pods(namespace).Create(nil, pod, metav1.CreateOptions{})
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, makeTestKnightCR("tristan", namespace, "infrastructure"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}

	// Terminating pod from an old ReplicaSet — sorts before the ready pod by
	// name; the handler must prefer the ready one (#125)
	oldPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "tristan-abc123",
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":     "knight",
				"app.kubernetes.io/instance": "tristan",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "knight", Image: "knight:v0"}},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{
				{Name: "knight", Ready: false},
			},
		},
	}
	fakeK8sClient.CoreV1().Pods(namespace).Create(nil, oldPod, metav1.CreateOptions{})

	tests := []struct {
		name           string
		knightName     string
		expectedStatus int
		checkResponse  func(t *testing.T, body []byte)
	}{
		{
			name:           "valid knight returns 200 with details",
			knightName:     "tristan",
			expectedStatus: http.StatusOK,
			checkResponse: func(t *testing.T, body []byte) {
				var detail KnightDetail
				if err := json.Unmarshal(body, &detail); err != nil {
					t.Fatalf("failed to parse response: %v", err)
				}
				if detail.Name != "tristan" {
					t.Errorf("expected name 'tristan', got '%s'", detail.Name)
				}
				if detail.Node != "node-1" {
					t.Errorf("expected node 'node-1', got '%s'", detail.Node)
				}
				if detail.PodName != "tristan-xyz789" {
					t.Errorf("expected ready pod 'tristan-xyz789', got '%s'", detail.PodName)
				}
				if detail.PodPhase != "Running" {
					t.Errorf("expected podPhase 'Running', got '%s'", detail.PodPhase)
				}
				// The JSON phase key must carry the CRD phase, not the pod
				// phase — KnightDetail.PodPhase must not shadow it (#125)
				var raw map[string]interface{}
				json.Unmarshal(body, &raw)
				if raw["phase"] != "Ready" {
					t.Errorf("expected JSON phase 'Ready' (CRD phase), got '%v'", raw["phase"])
				}
			},
		},
		{
			name:           "non-existent knight returns 404",
			knightName:     "nonexistent",
			expectedStatus: http.StatusNotFound,
			checkResponse:  func(t *testing.T, body []byte) {},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/fleet/"+tt.knightName, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, w.Code)
			}

			tt.checkResponse(t, w.Body.Bytes())
		})
	}
}

// TestAuthMiddleware tests the authentication middleware
func TestAuthMiddleware(t *testing.T) {
	tests := []struct {
		name           string
		apiKey         string
		setEnv         bool
		authHeader     string
		path           string
		expectedStatus int
	}{
		{
			name:           "no API key configured - allows all requests",
			apiKey:         "",
			setEnv:         false,
			authHeader:     "",
			path:           "/api/fleet",
			expectedStatus: http.StatusOK,
		},
		{
			name:           "API key configured - valid key succeeds",
			apiKey:         "secret123",
			setEnv:         true,
			authHeader:     "Bearer secret123",
			path:           "/api/fleet",
			expectedStatus: http.StatusOK,
		},
		{
			name:           "API key configured - invalid key fails",
			apiKey:         "secret123",
			setEnv:         true,
			authHeader:     "Bearer wrongkey",
			path:           "/api/fleet",
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "API key configured - missing auth header fails",
			apiKey:         "secret123",
			setEnv:         true,
			authHeader:     "",
			path:           "/api/fleet",
			expectedStatus: http.StatusUnauthorized,
		},
		{
			name:           "health endpoint bypasses auth",
			apiKey:         "secret123",
			setEnv:         true,
			authHeader:     "",
			path:           "/api/health",
			expectedStatus: http.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Setup environment
			if tt.setEnv {
				os.Setenv("DASHBOARD_API_KEY", tt.apiKey)
				defer os.Unsetenv("DASHBOARD_API_KEY")
			}

			// Create router with auth middleware
			router := setupTestRouter()
			r := mux.NewRouter()
			r.Use(authMiddleware)
			r.PathPrefix("/api").Handler(router)

			req := httptest.NewRequest("GET", tt.path, nil)
			if tt.authHeader != "" {
				req.Header.Set("Authorization", tt.authHeader)
			}
			w := httptest.NewRecorder()

			r.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, w.Code)
			}
		})
	}
}

// TestAuthLoginEndpoint tests the /api/auth/login endpoint
func TestAuthLoginEndpoint(t *testing.T) {
	tests := []struct {
		name           string
		envAPIKey      string
		requestBody    map[string]string
		expectedStatus int
		expectSuccess  bool
	}{
		{
			name:           "valid API key",
			envAPIKey:      "mykey123",
			requestBody:    map[string]string{"apiKey": "mykey123"},
			expectedStatus: http.StatusOK,
			expectSuccess:  true,
		},
		{
			name:           "invalid API key",
			envAPIKey:      "mykey123",
			requestBody:    map[string]string{"apiKey": "wrongkey"},
			expectedStatus: http.StatusUnauthorized,
			expectSuccess:  false,
		},
		{
			name:           "no API key configured - allows any key",
			envAPIKey:      "",
			requestBody:    map[string]string{"apiKey": "anykey"},
			expectedStatus: http.StatusOK,
			expectSuccess:  false, // No auth required, so no "authenticated" field expected
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.envAPIKey != "" {
				os.Setenv("DASHBOARD_API_KEY", tt.envAPIKey)
				defer os.Unsetenv("DASHBOARD_API_KEY")
			}

			router := mux.NewRouter()
			router.Use(authMiddleware)
			api := router.PathPrefix("/api").Subrouter()
			api.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
				// Handled by middleware
			}).Methods("POST")

			body, _ := json.Marshal(tt.requestBody)
			req := httptest.NewRequest("POST", "/api/auth/login", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, w.Code)
			}

			var response map[string]interface{}
			json.Unmarshal(w.Body.Bytes(), &response)

			if tt.expectSuccess {
				if auth, ok := response["authenticated"].(bool); !ok || !auth {
					t.Error("expected authenticated=true in response")
				}
			}
		})
	}
}

// TestValidKnightName tests the knight name validation regex
func TestValidKnightName(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected bool
	}{
		{"valid lowercase", "galahad", true},
		{"valid with hyphen", "galahad-dev", true},
		{"valid with numbers", "knight1", true},
		{"valid mixed", "Knight-01", true},
		{"invalid starts with number", "1knight", false},
		{"invalid special chars", "knight@test", false},
		{"invalid path traversal", "../galahad", false},
		{"invalid NATS wildcard", "fleet-a.>", false},
		{"invalid too long", strings.Repeat("a", 64), false},
		{"empty string", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := validKnightName.MatchString(tt.input)
			if result != tt.expected {
				t.Errorf("validKnightName(%s) = %v, expected %v", tt.input, result, tt.expected)
			}
		})
	}
}

// TestBriefingHandler tests the /api/briefings/{date} endpoint
func TestBriefingHandler(t *testing.T) {
	// Create temporary vault directory
	tmpDir := t.TempDir()
	briefingsDir := fmt.Sprintf("%s/Briefings/Daily", tmpDir)
	os.MkdirAll(briefingsDir, 0755)

	// Create a test briefing file
	testContent := "# Daily Briefing 2024-01-01\n\nTest content"
	os.WriteFile(fmt.Sprintf("%s/2024-01-01.md", briefingsDir), []byte(testContent), 0644)

	vaultPath := tmpDir

	router := mux.NewRouter()
	api := router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/briefings/{date}", briefingHandler(vaultPath, []string{"Briefings/Daily", "Agents/Briefings"})).Methods("GET")

	tests := []struct {
		name           string
		date           string
		expectedStatus int
		expectedBody   string
	}{
		{
			name:           "valid date returns briefing",
			date:           "2024-01-01",
			expectedStatus: http.StatusOK,
			expectedBody:   testContent,
		},
		{
			name:           "non-existent date returns 404",
			date:           "2024-12-31",
			expectedStatus: http.StatusNotFound,
			expectedBody:   "",
		},
		{
			name:           "invalid date format returns 400",
			date:           "invalid",
			expectedStatus: http.StatusBadRequest,
			expectedBody:   "",
		},
		{
			name:           "date with special chars returns 400",
			date:           "2024-01@01", // Special chars - invalid format
			expectedStatus: http.StatusBadRequest,
			expectedBody:   "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/briefings/"+tt.date, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, w.Code)
			}

			if tt.expectedBody != "" && w.Body.String() != tt.expectedBody {
				t.Errorf("expected body '%s', got '%s'", tt.expectedBody, w.Body.String())
			}
		})
	}
}

// TestBriefingHandlerErrors covers size cap and read-error answers: only a
// missing file is 404; oversized files are 413; other read failures are 500.
func TestBriefingHandlerErrors(t *testing.T) {
	tmpDir := t.TempDir()
	dir := "Briefings/Daily"
	briefingsDir := filepath.Join(tmpDir, dir)
	if err := os.MkdirAll(briefingsDir, 0755); err != nil {
		t.Fatal(err)
	}

	router := mux.NewRouter()
	api := router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/briefings/{date}", briefingHandler(tmpDir, []string{dir})).Methods("GET")

	serve := func(date string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "/api/briefings/"+date, nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w
	}

	t.Run("exactly the cap is served", func(t *testing.T) {
		content := strings.Repeat("a", maxBriefingBytes)
		if err := os.WriteFile(filepath.Join(briefingsDir, "2026-01-02.md"), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		w := serve("2026-01-02")
		if w.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", w.Code)
		}
		if w.Body.Len() != maxBriefingBytes {
			t.Errorf("expected %d bytes, got %d", maxBriefingBytes, w.Body.Len())
		}
	})

	t.Run("one byte over the cap answers 413", func(t *testing.T) {
		content := strings.Repeat("a", maxBriefingBytes+1)
		if err := os.WriteFile(filepath.Join(briefingsDir, "2026-01-03.md"), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
		w := serve("2026-01-03")
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("expected 413, got %d", w.Code)
		}
		if strings.Contains(w.Body.String(), "aaaa") {
			t.Error("413 body must not contain briefing content")
		}
		if !strings.Contains(w.Body.String(), fmt.Sprint(maxBriefingBytes)) {
			t.Errorf("413 body should state the limit, got %s", w.Body.String())
		}
	})

	t.Run("missing file answers 404 without the vault path", func(t *testing.T) {
		w := serve("2026-01-04")
		if w.Code != http.StatusNotFound {
			t.Fatalf("expected 404, got %d", w.Code)
		}
		if strings.Contains(w.Body.String(), tmpDir) {
			t.Errorf("404 body leaks the vault path: %s", w.Body.String())
		}
	})

	t.Run("directory with the briefing name answers 404", func(t *testing.T) {
		if err := os.MkdirAll(filepath.Join(briefingsDir, "2026-01-05.md"), 0755); err != nil {
			t.Fatal(err)
		}
		w := serve("2026-01-05")
		if w.Code != http.StatusNotFound {
			t.Fatalf("expected 404, got %d", w.Code)
		}
	})

	t.Run("unreadable file answers 500", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root ignores file permissions")
		}
		p := filepath.Join(briefingsDir, "2026-01-06.md")
		if err := os.WriteFile(p, []byte("secret"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, 0); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { os.Chmod(p, 0644) })

		var buf bytes.Buffer
		prev := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
		t.Cleanup(func() { slog.SetDefault(prev) })

		w := serve("2026-01-06")
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d", w.Code)
		}
		if strings.Contains(w.Body.String(), tmpDir) {
			t.Errorf("500 body leaks the vault path: %s", w.Body.String())
		}
		if n := strings.Count(buf.String(), "briefing read failed"); n != 1 {
			t.Errorf("expected exactly one 'briefing read failed' log line, got %d: %q", n, buf.String())
		}
	})
}

// TestBriefingHandlerSkipsFIFO checks that a FIFO named like a briefing is
// answered 404 instead of blocking the handler on open.
func TestBriefingHandlerSkipsFIFO(t *testing.T) {
	tmpDir := t.TempDir()
	dir := "Briefings/Daily"
	briefingsDir := filepath.Join(tmpDir, dir)
	if err := os.MkdirAll(briefingsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := syscall.Mkfifo(filepath.Join(briefingsDir, "2026-01-08.md"), 0644); err != nil {
		t.Skipf("mkfifo unavailable: %v", err)
	}

	router := mux.NewRouter()
	api := router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/briefings/{date}", briefingHandler(tmpDir, []string{dir})).Methods("GET")

	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, httptest.NewRequest("GET", "/api/briefings/2026-01-08", nil))
		done <- w
	}()
	select {
	case w := <-done:
		if w.Code != http.StatusNotFound {
			t.Fatalf("expected 404 for a FIFO, got %d", w.Code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("handler blocked on a FIFO briefing")
	}
}

// TestMissionsHandler tests the /api/missions endpoint
func TestMissionsHandler(t *testing.T) {
	router := setupTestRouter()

	// Create test mission CRD
	mission := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "Mission",
			"metadata": map[string]interface{}{
				"name":      "test-mission",
				"namespace": "test-namespace",
			},
			"spec": map[string]interface{}{
				"objective":     "Test objective",
				"costBudgetUSD": "10.00",
				"roundTableRef": map[string]interface{}{"name": "table-a"},
			},
			"status": map[string]interface{}{
				"phase":     "Running",
				"totalCost": "5.00",
			},
		},
	}

	_, err := dynClient.Resource(missionGVR).Namespace("test-namespace").Create(nil, mission, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create test mission: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/missions", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var missions []MissionSummary
	if err := json.Unmarshal(w.Body.Bytes(), &missions); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if len(missions) != 1 {
		t.Fatalf("expected 1 mission, got %d", len(missions))
	}

	if missions[0].Name != "test-mission" {
		t.Errorf("expected name 'test-mission', got '%s'", missions[0].Name)
	}

	if missions[0].Phase != "Running" {
		t.Errorf("expected phase 'Running', got '%s'", missions[0].Phase)
	}
}

// TestMissionCreateHandler tests the POST /api/missions endpoint
func TestMissionCreateHandler(t *testing.T) {
	router := setupTestRouter()

	tests := []struct {
		name           string
		requestBody    map[string]interface{}
		expectedStatus int
		// checkSpec, when set, inspects the spec of the Mission read back
		// from the dynamic client after a 201.
		checkSpec func(t *testing.T, spec map[string]interface{})
	}{
		{
			name: "valid mission creation",
			requestBody: map[string]interface{}{
				"name":      "new-mission",
				"objective": "Test objective",
				"knights": []map[string]string{
					{"name": "galahad"},
				},
			},
			expectedStatus: http.StatusCreated,
		},
		{
			name: "invalid mission name",
			requestBody: map[string]interface{}{
				"name":      "../../malicious",
				"objective": "Bad objective",
			},
			expectedStatus: http.StatusBadRequest,
		},
		{
			name: "meta-mission without planner uses table planner",
			requestBody: map[string]interface{}{
				"name":        "meta-no-planner",
				"objective":   "Plan it",
				"metaMission": true,
			},
			expectedStatus: http.StatusCreated,
			checkSpec: func(t *testing.T, spec map[string]interface{}) {
				if _, has := spec["planner"]; has {
					t.Errorf("spec.planner should be absent when the request has none, got %v", spec["planner"])
				}
			},
		},
		{
			name: "meta-mission with planner options only",
			requestBody: map[string]interface{}{
				"name":        "meta-opts-only",
				"objective":   "Plan it",
				"metaMission": true,
				"planner":     map[string]interface{}{"maxChains": 3},
			},
			expectedStatus: http.StatusCreated,
			checkSpec: func(t *testing.T, spec map[string]interface{}) {
				planner, _ := spec["planner"].(map[string]interface{})
				if planner == nil {
					t.Fatalf("spec.planner missing: %v", spec)
				}
				if _, has := planner["knightRef"]; has {
					t.Errorf("spec.planner.knightRef should be absent, got %v", planner["knightRef"])
				}
				if planner["maxChains"] != float64(3) {
					t.Errorf("spec.planner.maxChains = %v, want 3", planner["maxChains"])
				}
			},
		},
		{
			name: "meta-mission with invalid planner knightRef",
			requestBody: map[string]interface{}{
				"name":        "meta-bad-planner",
				"objective":   "Plan it",
				"metaMission": true,
				"planner":     map[string]interface{}{"knightRef": map[string]interface{}{"name": "../bad"}},
			},
			expectedStatus: http.StatusBadRequest,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(tt.requestBody)
			req := httptest.NewRequest("POST", "/api/missions", bytes.NewReader(body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			router.ServeHTTP(w, req)

			if w.Code != tt.expectedStatus {
				t.Errorf("expected status %d, got %d", tt.expectedStatus, w.Code)
			}
			if tt.checkSpec != nil && w.Code == http.StatusCreated {
				var created struct {
					Name string `json:"name"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
					t.Fatalf("parse response: %v", err)
				}
				obj, err := dynClient.Resource(missionGVR).Namespace("test-namespace").Get(context.Background(), created.Name, metav1.GetOptions{})
				if err != nil {
					t.Fatalf("read back mission %q: %v", created.Name, err)
				}
				spec, _ := obj.Object["spec"].(map[string]interface{})
				tt.checkSpec(t, spec)
			}
		})
	}
}

// TestMissionDeleteHandler tests the DELETE /api/missions/{name} endpoint
func TestMissionDeleteHandler(t *testing.T) {
	router := setupTestRouter()

	// Create a mission to delete
	mission := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "Mission",
			"metadata": map[string]interface{}{
				"name":      "delete-me",
				"namespace": "test-namespace",
			},
			"spec": map[string]interface{}{},
		},
	}
	dynClient.Resource(missionGVR).Namespace("test-namespace").Create(nil, mission, metav1.CreateOptions{})

	req := httptest.NewRequest("DELETE", "/api/missions/delete-me", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var response map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &response)

	if deleted, ok := response["deleted"].(bool); !ok || !deleted {
		t.Error("expected deleted=true in response")
	}
}

// TestChainsHandler tests the /api/chains endpoint
func TestChainsHandler(t *testing.T) {
	router := setupTestRouter()

	chain := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "Chain",
			"metadata": map[string]interface{}{
				"name":      "test-chain",
				"namespace": "test-namespace",
			},
			"spec": map[string]interface{}{
				"steps": []interface{}{
					map[string]interface{}{
						"name":      "step-1",
						"knightRef": map[string]interface{}{"name": "galahad"},
						"domain":    "security",
					},
				},
			},
			"status": map[string]interface{}{
				"phase": "Running",
			},
		},
	}

	dynClient.Resource(chainGVR).Namespace("test-namespace").Create(nil, chain, metav1.CreateOptions{})

	req := httptest.NewRequest("GET", "/api/chains", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var chains []ChainSummary
	json.Unmarshal(w.Body.Bytes(), &chains)

	if len(chains) != 1 {
		t.Fatalf("expected 1 chain, got %d", len(chains))
	}

	if chains[0].Name != "test-chain" {
		t.Errorf("expected name 'test-chain', got '%s'", chains[0].Name)
	}
}

// TestRoundTablesHandler tests the /api/roundtables endpoint
func TestRoundTablesHandler(t *testing.T) {
	router := setupTestRouter()

	roundtable := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "RoundTable",
			"metadata": map[string]interface{}{
				"name":      "table-a",
				"namespace": "test-namespace",
			},
			"spec": map[string]interface{}{
				"nats": map[string]interface{}{
					"subjectPrefix": "fleet-a",
				},
			},
			"status": map[string]interface{}{
				"phase":        "Ready",
				"knightsReady": int64(3),
				"knightsTotal": int64(5),
			},
		},
	}

	dynClient.Resource(roundTableGVR).Namespace("test-namespace").Create(nil, roundtable, metav1.CreateOptions{})

	req := httptest.NewRequest("GET", "/api/roundtables", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var tables []RoundTableSummary
	json.Unmarshal(w.Body.Bytes(), &tables)

	if len(tables) != 1 {
		t.Fatalf("expected 1 roundtable, got %d", len(tables))
	}

	if tables[0].Name != "table-a" {
		t.Errorf("expected name 'table-a', got '%s'", tables[0].Name)
	}

	if tables[0].KnightsReady != 3 {
		t.Errorf("expected 3 ready knights, got %d", tables[0].KnightsReady)
	}
}

// TestRateLimiter tests the rate limiter
func TestRateLimiter(t *testing.T) {
	rl := newRateLimiter(2, 1*time.Second)

	// First two requests should succeed
	if !rl.allow() {
		t.Error("first request should be allowed")
	}
	if !rl.allow() {
		t.Error("second request should be allowed")
	}

	// Third request should be blocked
	if rl.allow() {
		t.Error("third request should be blocked")
	}

	// Wait for window to reset
	time.Sleep(1 * time.Second)

	// Should allow again
	if !rl.allow() {
		t.Error("request after reset should be allowed")
	}
}

// TestCapitalizeKnight tests the knight name capitalization
func TestCapitalizeKnight(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"galahad", "Galahad"},
		{"Galahad", "Galahad"},
		{"GALAHAD", "GALAHAD"},
		{"", ""},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := capitalizeKnight(tt.input)
			if result != tt.expected {
				t.Errorf("capitalizeKnight(%s) = %s, expected %s", tt.input, result, tt.expected)
			}
		})
	}
}

// TestEventTimestamp tests payload timestamp extraction for event dedup
func TestEventTimestamp(t *testing.T) {
	want := time.Date(2026, 6, 1, 12, 30, 0, 0, time.UTC)
	payload := []byte(`{"task_id":"galahad-ui-1","success":true,"timestamp":"2026-06-01T12:30:00Z"}`)
	if got := eventTimestamp(payload); !got.Equal(want) {
		t.Errorf("eventTimestamp = %v, expected %v", got, want)
	}

	// Missing / invalid timestamps fall back to roughly now
	for _, data := range [][]byte{
		[]byte(`{"task_id":"x"}`),
		[]byte(`{"timestamp":"not-a-time"}`),
		[]byte(`not json`),
		nil,
	} {
		got := eventTimestamp(data)
		if time.Since(got) > time.Minute || time.Until(got) > time.Minute {
			t.Errorf("eventTimestamp(%q) = %v, expected approximately now", data, got)
		}
	}
}

// TestEnvOr tests the environment variable helper
func TestEnvOr(t *testing.T) {
	os.Setenv("TEST_VAR", "value")
	defer os.Unsetenv("TEST_VAR")

	tests := []struct {
		name     string
		key      string
		def      string
		expected string
	}{
		{"existing var", "TEST_VAR", "default", "value"},
		{"missing var", "MISSING_VAR", "default", "default"},
		{"empty default", "MISSING_VAR", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := envOr(tt.key, tt.def)
			if result != tt.expected {
				t.Errorf("envOr(%s, %s) = %s, expected %s", tt.key, tt.def, result, tt.expected)
			}
		})
	}
}

// TestBuildKnightStatusWithCRD tests the enriched knight status builder with CRD data
func TestBuildKnightStatusWithCRD(t *testing.T) {
	now := metav1.Now()

	// Create Knight CR with enriched fields
	cr := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "Knight",
			"metadata": map[string]interface{}{
				"name":              "galahad",
				"namespace":         "test-namespace",
				"creationTimestamp": now.Format(time.RFC3339),
			},
			"spec": map[string]interface{}{
				"domain":             "security",
				"model":              "anthropic/claude-3-5-sonnet-20241022",
				"runtime":            "pi@0.14.5",
				"suspend":            false,
				"concurrency":        int64(3),
				"taskTimeoutSeconds": int64(600),
				"skills":             []interface{}{"vulnerability-scan", "penetration-test"},
			},
			"status": map[string]interface{}{
				"phase":          "Ready",
				"tasksCompleted": int64(150),
				"tasksFailed":    int64(5),
				"totalCost":      "$12.45",
			},
		},
	}
	cr.SetCreationTimestamp(now)

	// Create matching pod
	started := metav1.NewTime(now.Add(-time.Hour))
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:              "galahad-abc123",
			Namespace:         "test-namespace",
			CreationTimestamp: now,
			Labels: map[string]string{
				"app.kubernetes.io/instance": "galahad",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{Image: "knight:latest"},
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{
				{
					Ready:        true,
					RestartCount: 2,
					State: corev1.ContainerState{
						Running: &corev1.ContainerStateRunning{StartedAt: started},
					},
				},
			},
		},
	}

	status := buildKnightStatus(cr, pod, nil)
	if want := started.UTC().Format(time.RFC3339); status.StartedAt != want {
		t.Errorf("expected startedAt %q, got %q", want, status.StartedAt)
	}

	// Test basic fields
	if status.Name != "galahad" {
		t.Errorf("expected name 'galahad', got '%s'", status.Name)
	}

	if status.Domain != "security" {
		t.Errorf("expected domain 'security', got '%s'", status.Domain)
	}

	if status.Status != "online" {
		t.Errorf("expected status 'online', got '%s'", status.Status)
	}

	if status.Restarts != 2 {
		t.Errorf("expected 2 restarts, got %d", status.Restarts)
	}

	if !status.Ready {
		t.Error("expected ready=true")
	}

	// Test enriched CRD fields
	if status.Phase != "Ready" {
		t.Errorf("expected phase 'Ready', got '%s'", status.Phase)
	}

	if status.Model != "anthropic/claude-3-5-sonnet-20241022" {
		t.Errorf("expected model 'anthropic/claude-3-5-sonnet-20241022', got '%s'", status.Model)
	}

	if status.Runtime != "pi@0.14.5" {
		t.Errorf("expected runtime 'pi@0.14.5', got '%s'", status.Runtime)
	}

	if status.Suspend {
		t.Error("expected suspended=false")
	}

	if status.TasksCompleted != 150 {
		t.Errorf("expected 150 tasks completed, got %d", status.TasksCompleted)
	}

	if status.TasksFailed != 5 {
		t.Errorf("expected 5 tasks failed, got %d", status.TasksFailed)
	}

	if status.TotalCost != "$12.45" {
		t.Errorf("expected totalCost '$12.45', got '%s'", status.TotalCost)
	}

	if status.Concurrency != 3 {
		t.Errorf("expected concurrency 3, got %d", status.Concurrency)
	}

	if status.TaskTimeoutSeconds != 600 {
		t.Errorf("expected taskTimeout 600, got %d", status.TaskTimeoutSeconds)
	}

	if len(status.SkillsList) != 2 {
		t.Errorf("expected 2 skills, got %d", len(status.SkillsList))
	}
}

// TestFleetHandlerEnrichedFields tests that /api/fleet returns enriched Knight CRD fields
func TestFleetHandlerEnrichedFields(t *testing.T) {
	router := setupTestRouter()
	namespace := "test-namespace"

	now := metav1.Now()

	// Create Knight CR with enriched fields
	knight := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "Knight",
			"metadata": map[string]interface{}{
				"name":              "percival",
				"namespace":         namespace,
				"creationTimestamp": now.Format(time.RFC3339),
			},
			"spec": map[string]interface{}{
				"domain":             "infrastructure",
				"model":              "openai/gpt-4o",
				"runtime":            "pi@0.14.5",
				"suspend":            false,
				"concurrency":        int64(5),
				"taskTimeoutSeconds": int64(900),
				"skills":             []interface{}{"kubernetes-ops", "terraform"},
			},
			"status": map[string]interface{}{
				"phase":          "Ready",
				"tasksCompleted": int64(250),
				"tasksFailed":    int64(10),
				"totalCost":      "$45.67",
			},
		},
	}
	knight.SetCreationTimestamp(now)

	_, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, knight, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create knight CR: %v", err)
	}

	// Create matching pod
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:              "percival-xyz123",
			Namespace:         namespace,
			CreationTimestamp: now,
			Labels: map[string]string{
				"app.kubernetes.io/name":     "knight",
				"app.kubernetes.io/instance": "percival",
			},
		},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{
				{
					Name:  "knight",
					Image: "ghcr.io/roundtable-k8s/knight:latest",
				},
			},
		},
		Status: corev1.PodStatus{
			Phase: corev1.PodRunning,
			ContainerStatuses: []corev1.ContainerStatus{
				{
					Name:         "knight",
					Image:        "ghcr.io/roundtable-k8s/knight:latest",
					Ready:        true,
					RestartCount: 0,
				},
			},
		},
	}

	k8sClient = k8sfake.NewSimpleClientset(pod)

	req := httptest.NewRequest("GET", "/api/fleet", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var knights []KnightStatus
	if err := json.Unmarshal(w.Body.Bytes(), &knights); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if len(knights) != 1 {
		t.Fatalf("expected 1 knight, got %d", len(knights))
	}

	k := knights[0]

	// Verify enriched fields are present
	if k.Phase != "Ready" {
		t.Errorf("expected phase 'Ready', got '%s'", k.Phase)
	}

	if k.Model != "openai/gpt-4o" {
		t.Errorf("expected model 'openai/gpt-4o', got '%s'", k.Model)
	}

	if k.Runtime != "pi@0.14.5" {
		t.Errorf("expected runtime 'pi@0.14.5', got '%s'", k.Runtime)
	}

	if k.TasksCompleted != 250 {
		t.Errorf("expected tasksCompleted 250, got %d", k.TasksCompleted)
	}

	if k.TasksFailed != 10 {
		t.Errorf("expected tasksFailed 10, got %d", k.TasksFailed)
	}

	if k.TotalCost != "$45.67" {
		t.Errorf("expected totalCost '$45.67', got '%s'", k.TotalCost)
	}

	if k.Concurrency != 5 {
		t.Errorf("expected concurrency 5, got %d", k.Concurrency)
	}

	if k.TaskTimeoutSeconds != 900 {
		t.Errorf("expected taskTimeout 900, got %d", k.TaskTimeoutSeconds)
	}

	if len(k.SkillsList) != 2 {
		t.Errorf("expected 2 skills, got %d", len(k.SkillsList))
	}
}

// Helper functions
func boolPtr(b bool) *bool {
	return &b
}

// TestGetNestedMap tests the nested map helper
func TestGetNestedMap(t *testing.T) {
	obj := map[string]interface{}{
		"spec": map[string]interface{}{
			"key": "value",
		},
	}

	result := getNestedMap(obj, "spec")
	if result == nil {
		t.Error("expected non-nil map")
	}

	if result["key"] != "value" {
		t.Errorf("expected key='value', got '%v'", result["key"])
	}

	// Test missing key
	result = getNestedMap(obj, "missing")
	if result != nil {
		t.Error("expected nil for missing key")
	}
}

// TestGetStr tests the string getter helper
func TestGetStr(t *testing.T) {
	obj := map[string]interface{}{
		"name": "test",
		"num":  123,
	}

	if getStr(obj, "name") != "test" {
		t.Error("expected 'test'")
	}

	if getStr(obj, "num") != "" {
		t.Error("expected empty string for non-string value")
	}

	if getStr(obj, "missing") != "" {
		t.Error("expected empty string for missing key")
	}

	if getStr(nil, "any") != "" {
		t.Error("expected empty string for nil map")
	}
}

// TestGetInt tests the int getter helper
func TestGetInt(t *testing.T) {
	obj := map[string]interface{}{
		"count":   float64(42),
		"count64": int64(100),
		"str":     "not a number",
	}

	if getInt(obj, "count") != 42 {
		t.Error("expected 42")
	}

	if getInt(obj, "count64") != 100 {
		t.Error("expected 100")
	}

	if getInt(obj, "str") != 0 {
		t.Error("expected 0 for non-number")
	}

	if getInt(obj, "missing") != 0 {
		t.Error("expected 0 for missing key")
	}
}

// TestRoundTableHandlerWithPolicies tests enriched RoundTable fields
func TestRoundTableHandlerWithPolicies(t *testing.T) {
	router := setupTestRouter()

	// Create RoundTable CR with policies
	roundtable := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "RoundTable",
			"metadata": map[string]interface{}{
				"name":      "table-b",
				"namespace": "test-namespace",
			},
			"spec": map[string]interface{}{
				"description": "Production Round Table",
				"nats": map[string]interface{}{
					"subjectPrefix": "fleet-b",
				},
				"policies": map[string]interface{}{
					"maxConcurrentPlanTasks": int64(6),
					"costBudgetUSD":          "500.00",
					"maxMissions":            int64(10),
				},
				"suspend":   false,
				"ephemeral": false,
			},
			"status": map[string]interface{}{
				"phase":               "Ready",
				"knightsReady":        int64(8),
				"knightsTotal":        int64(10),
				"totalCost":           "$125.50",
				"totalTasksCompleted": int64(5000),
				"activeMissions":      int64(3),
			},
		},
	}

	_, err := dynClient.Resource(roundTableGVR).Namespace("test-namespace").Create(nil, roundtable, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create roundtable: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/roundtables", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var tables []RoundTableSummary
	if err := json.Unmarshal(w.Body.Bytes(), &tables); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	// Should have 2 tables (one from earlier test + this one)
	if len(tables) < 1 {
		t.Fatalf("expected at least 1 roundtable, got %d", len(tables))
	}

	// Find our table
	var rt *RoundTableSummary
	for i := range tables {
		if tables[i].Name == "table-b" {
			rt = &tables[i]
			break
		}
	}

	if rt == nil {
		t.Fatal("table-b not found in response")
	}

	// Verify enriched fields
	if rt.Phase != "Ready" {
		t.Errorf("expected phase 'Ready', got '%s'", rt.Phase)
	}

	if rt.Description != "Production Round Table" {
		t.Errorf("expected description 'Production Round Table', got '%s'", rt.Description)
	}

	if rt.NATSPrefix != "fleet-b" {
		t.Errorf("expected NATS prefix 'fleet-b', got '%s'", rt.NATSPrefix)
	}

	// Test Policies
	if rt.Policies == nil {
		t.Fatal("expected policies to be present")
	}

	if rt.Policies.MaxConcurrentPlanTasks != 6 {
		t.Errorf("expected maxConcurrentPlanTasks 6, got %d", rt.Policies.MaxConcurrentPlanTasks)
	}

	if rt.Policies.CostBudgetUSD != "500.00" {
		t.Errorf("expected costBudgetUSD '500.00', got '%s'", rt.Policies.CostBudgetUSD)
	}

	if rt.Policies.MaxMissions != 10 {
		t.Errorf("expected maxMissions 10, got %d", rt.Policies.MaxMissions)
	}

	// Test other status fields
	if rt.KnightsReady != 8 {
		t.Errorf("expected knightsReady 8, got %d", rt.KnightsReady)
	}

	if rt.KnightsTotal != 10 {
		t.Errorf("expected knightsTotal 10, got %d", rt.KnightsTotal)
	}

	if rt.TotalTasksCompleted != 5000 {
		t.Errorf("expected totalTasksCompleted 5000, got %d", rt.TotalTasksCompleted)
	}

	if rt.ActiveMissions != 3 {
		t.Errorf("expected activeMissions 3, got %d", rt.ActiveMissions)
	}
}

// TestMissionHandlerWithKnightAndChainStatuses tests enriched Mission fields
func TestMissionHandlerWithKnightAndChainStatuses(t *testing.T) {
	router := setupTestRouter()

	// Create Mission CR with knight and chain statuses
	mission := &unstructured.Unstructured{
		Object: map[string]interface{}{
			"apiVersion": "ai.roundtable.io/v1alpha1",
			"kind":       "Mission",
			"metadata": map[string]interface{}{
				"name":      "enriched-mission",
				"namespace": "test-namespace",
			},
			"spec": map[string]interface{}{
				"objective":       "Test enriched mission",
				"costBudgetUSD":   "100.00",
				"roundTableRef":   map[string]interface{}{"name": "table-a"},
				"ttlSeconds":      int64(3600),
				"timeoutSeconds":  int64(1800),
				"cleanupPolicy":   "Retain",
				"recruitExisting": true,
				"retainResults":   true,
				"knights": []interface{}{
					map[string]interface{}{"name": "galahad"},
					map[string]interface{}{"name": "percival"},
				},
				"chains": []interface{}{
					map[string]interface{}{"name": "recon-chain"},
				},
			},
			"status": map[string]interface{}{
				"phase":            "Running",
				"totalCost":        "$25.00",
				"startedAt":        "2024-01-01T10:00:00Z",
				"resultsConfigMap": "enriched-mission-results",
				"knightStatuses": []interface{}{
					map[string]interface{}{
						"name":           "galahad",
						"ready":          true,
						"tasksCompleted": int64(50),
						"ephemeral":      false,
					},
					map[string]interface{}{
						"name":           "percival",
						"ready":          true,
						"tasksCompleted": int64(30),
						"ephemeral":      true,
					},
				},
				"chainStatuses": []interface{}{
					map[string]interface{}{
						"name":        "recon-chain",
						"chainCRName": "enriched-mission-recon-chain",
						"phase":       "Running",
					},
				},
			},
		},
	}

	_, err := dynClient.Resource(missionGVR).Namespace("test-namespace").Create(nil, mission, metav1.CreateOptions{})
	if err != nil {
		t.Fatalf("failed to create mission: %v", err)
	}

	req := httptest.NewRequest("GET", "/api/missions/enriched-mission", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", w.Code)
	}

	var m MissionSummary
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	// Verify basic fields
	if m.Name != "enriched-mission" {
		t.Errorf("expected name 'enriched-mission', got '%s'", m.Name)
	}

	if m.Phase != "Running" {
		t.Errorf("expected phase 'Running', got '%s'", m.Phase)
	}

	if m.CleanupPolicy != "Retain" {
		t.Errorf("expected cleanupPolicy 'Retain', got '%s'", m.CleanupPolicy)
	}

	if !m.RecruitExisting {
		t.Error("expected recruitExisting=true")
	}

	if !m.RetainResults {
		t.Error("expected retainResults=true")
	}

	if m.ResultsConfigMap != "enriched-mission-results" {
		t.Errorf("expected resultsConfigMap 'enriched-mission-results', got '%s'", m.ResultsConfigMap)
	}

	// Test KnightStatuses
	if len(m.KnightStatuses) != 2 {
		t.Fatalf("expected 2 knight statuses, got %d", len(m.KnightStatuses))
	}

	// Find galahad
	var galahad *MissionKnightStatusDTO
	for i := range m.KnightStatuses {
		if m.KnightStatuses[i].Name == "galahad" {
			galahad = &m.KnightStatuses[i]
			break
		}
	}

	if galahad == nil {
		t.Fatal("galahad not found in knightStatuses")
	}

	if !galahad.Ready {
		t.Error("expected galahad ready=true")
	}

	if galahad.TasksCompleted != 50 {
		t.Errorf("expected galahad tasksCompleted 50, got %d", galahad.TasksCompleted)
	}

	if galahad.Ephemeral {
		t.Error("expected galahad ephemeral=false")
	}

	// Find percival
	var percival *MissionKnightStatusDTO
	for i := range m.KnightStatuses {
		if m.KnightStatuses[i].Name == "percival" {
			percival = &m.KnightStatuses[i]
			break
		}
	}

	if percival == nil {
		t.Fatal("percival not found in knightStatuses")
	}

	if !percival.Ephemeral {
		t.Error("expected percival ephemeral=true")
	}

	// Test ChainStatuses
	if len(m.ChainStatuses) != 1 {
		t.Fatalf("expected 1 chain status, got %d", len(m.ChainStatuses))
	}

	chain := m.ChainStatuses[0]
	if chain.Name != "recon-chain" {
		t.Errorf("expected chain name 'recon-chain', got '%s'", chain.Name)
	}

	if chain.ChainCRName != "enriched-mission-recon-chain" {
		t.Errorf("expected chainCRName 'enriched-mission-recon-chain', got '%s'", chain.ChainCRName)
	}

	if chain.Phase != "Running" {
		t.Errorf("expected chain phase 'Running', got '%s'", chain.Phase)
	}
}

// TestInputValidation tests NATS injection prevention
func TestInputValidation(t *testing.T) {
	tests := []struct {
		name  string
		input string
		valid bool
	}{
		{"valid knight name", "galahad", true},
		{"valid with hyphen", "knight-dev", true},
		{"valid with number", "knight1", true},
		{"NATS wildcard injection", "fleet.>", false},
		{"NATS subject injection", "fleet.tasks.*", false},
		{"path traversal", "../../../etc/passwd", false},
		{"starts with number", "1knight", false},
		{"special characters", "knight@test!", false},
		{"too long", strings.Repeat("a", 64), false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := validKnightName.MatchString(tt.input)
			if result != tt.valid {
				t.Errorf("validKnightName(%s) = %v, expected %v", tt.input, result, tt.valid)
			}
		})
	}
}

// TestAuthMiddlewareProtectedEndpoints verifies all API endpoints require auth when enabled
func TestAuthMiddlewareProtectedEndpoints(t *testing.T) {
	os.Setenv("DASHBOARD_API_KEY", "test-secret-key")
	defer os.Unsetenv("DASHBOARD_API_KEY")

	router := setupTestRouter()
	r := mux.NewRouter()
	r.Use(authMiddleware)
	r.PathPrefix("/api").Handler(router)

	protectedEndpoints := []struct {
		method string
		path   string
	}{
		{"GET", "/api/fleet"},
		{"GET", "/api/fleet/galahad"},
		{"GET", "/api/missions"},
		{"GET", "/api/chains"},
		{"GET", "/api/roundtables"},
		{"POST", "/api/missions"},
		{"DELETE", "/api/missions/test"},
		{"GET", "/api/config"},
	}

	for _, ep := range protectedEndpoints {
		t.Run(ep.method+" "+ep.path, func(t *testing.T) {
			var body *bytes.Reader
			if ep.method == "POST" {
				body = bytes.NewReader([]byte(`{"name":"test","objective":"test"}`))
			} else {
				body = bytes.NewReader([]byte{})
			}

			req := httptest.NewRequest(ep.method, ep.path, body)
			req.Header.Set("Content-Type", "application/json")
			// No auth header - should fail
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code != http.StatusUnauthorized {
				t.Errorf("expected 401 Unauthorized without auth, got %d", w.Code)
			}

			// With valid auth - should succeed (or at least not 401)
			req = httptest.NewRequest(ep.method, ep.path, body)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Authorization", "Bearer test-secret-key")
			w = httptest.NewRecorder()
			r.ServeHTTP(w, req)

			if w.Code == http.StatusUnauthorized {
				t.Errorf("expected non-401 with valid auth, got %d", w.Code)
			}
		})
	}
}

// TestHealthEndpointBypassesAuth verifies /api/health works without auth
func TestHealthEndpointBypassesAuth(t *testing.T) {
	os.Setenv("DASHBOARD_API_KEY", "secret")
	defer os.Unsetenv("DASHBOARD_API_KEY")

	router := setupTestRouter()
	r := mux.NewRouter()
	r.Use(authMiddleware)
	r.PathPrefix("/api").Handler(router)

	req := httptest.NewRequest("GET", "/api/health", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected /api/health to return 200 without auth, got %d", w.Code)
	}

	var response map[string]string
	json.Unmarshal(w.Body.Bytes(), &response)

	if response["status"] != "ok" {
		t.Errorf("expected status=ok, got %s", response["status"])
	}
}

// TestKnightSessionHandlerOfflineShortCircuit verifies that session/introspect
// requests for knights that are not Ready return a fast empty 200 ({}) instead
// of proxying to NATS and hanging until a 504 gateway timeout.
func TestKnightSessionHandlerOfflineShortCircuit(t *testing.T) {
	router := setupTestRouter()
	nc = nil // NATS unavailable — the short-circuit must fire before any NATS use
	t.Setenv("NAMESPACE", "test-namespace")
	namespace := "test-namespace"

	offline := makeTestKnightCR("lancelot", namespace, "infrastructure")
	offline.Object["status"] = map[string]interface{}{"phase": "Provisioning"}
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, offline, metav1.CreateOptions{}); err != nil {
		t.Fatalf("Failed to create knight CR: %v", err)
	}

	degraded := makeTestKnightCR("percival", namespace, "research")
	degraded.Object["status"] = map[string]interface{}{"phase": "Degraded", "ready": false}
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, degraded, metav1.CreateOptions{}); err != nil {
		t.Fatalf("Failed to create knight CR: %v", err)
	}

	for _, tt := range []struct {
		knight      string
		sessionType string
	}{
		{"lancelot", "stats"},
		{"lancelot", "recent"},
		{"lancelot", "tree"},
		{"percival", "stats"},
	} {
		t.Run(tt.knight+"/"+tt.sessionType, func(t *testing.T) {
			req := httptest.NewRequest("GET", fmt.Sprintf("/api/fleet/%s/session?type=%s", tt.knight, tt.sessionType), nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if w.Code != http.StatusOK {
				t.Fatalf("expected 200 for offline knight, got %d", w.Code)
			}
			if ct := w.Header().Get("Content-Type"); ct != "application/json" {
				t.Errorf("expected Content-Type application/json, got %s", ct)
			}
			var body map[string]interface{}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("expected valid JSON body, got %q: %v", w.Body.String(), err)
			}
			if len(body) != 0 {
				t.Errorf("expected empty JSON object, got %v", body)
			}
		})
	}
}

// TestKnightSessionTypeValidation covers the session-type whitelist and the
// type=session id validation (both fail fast before any NATS/CR work).
func TestKnightSessionTypeValidation(t *testing.T) {
	router := setupTestRouter()
	nc = nil

	tests := []struct {
		name           string
		query          string
		expectedStatus int
	}{
		{"unknown type rejected", "type=bogus", http.StatusBadRequest},
		{"history is allowed", "type=history", http.StatusServiceUnavailable}, // passes validation, fails at nc==nil
		{"session without id", "type=session", http.StatusBadRequest},
		{"session with path traversal id", "type=session&id=../etc/passwd", http.StatusBadRequest},
		{"session with valid uuid id", "type=session&id=019f4162-77c7-7cf6-97b3-114d47bd250b", http.StatusServiceUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/api/fleet/galahad/session?"+tt.query, nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tt.expectedStatus {
				t.Errorf("expected %d, got %d (body: %s)", tt.expectedStatus, w.Code, w.Body.String())
			}
		})
	}
}

// TestKnightSessionHandlerReadyKnightProceedsToNATS verifies that Ready knights
// are NOT short-circuited — the request proceeds to the NATS introspect proxy
// (which reports 503 here because the test has no NATS connection).
func TestKnightSessionHandlerReadyKnightProceedsToNATS(t *testing.T) {
	router := setupTestRouter()
	nc = nil
	t.Setenv("NAMESPACE", "test-namespace")
	namespace := "test-namespace"

	// makeTestKnightCR sets status.phase=Ready
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, makeTestKnightCR("galahad", namespace, "security"), metav1.CreateOptions{}); err != nil {
		t.Fatalf("Failed to create knight CR: %v", err)
	}

	// Readiness via status.ready=true (phase absent) must also pass through
	readyBool := makeTestKnightCR("gawain", namespace, "docs")
	readyBool.Object["status"] = map[string]interface{}{"ready": true}
	if _, err := dynClient.Resource(knightGVR).Namespace(namespace).Create(nil, readyBool, metav1.CreateOptions{}); err != nil {
		t.Fatalf("Failed to create knight CR: %v", err)
	}

	for _, knight := range []string{"galahad", "gawain"} {
		req := httptest.NewRequest("GET", "/api/fleet/"+knight+"/session?type=stats", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusServiceUnavailable {
			t.Errorf("expected ready knight %s to reach the NATS proxy (503 with nil NATS), got %d", knight, w.Code)
		}
	}
}

// TestKnightSessionHandlerMissingCRFallsBack verifies graceful degradation:
// when the Knight CR cannot be fetched the handler keeps the old proxy path
// (FLEET_PREFIX fallback) instead of short-circuiting.
func TestKnightSessionHandlerMissingCRFallsBack(t *testing.T) {
	router := setupTestRouter()
	nc = nil
	t.Setenv("NAMESPACE", "test-namespace")

	req := httptest.NewRequest("GET", "/api/fleet/unknown-knight/session?type=stats", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected fallback to NATS proxy (503 with nil NATS), got %d", w.Code)
	}
}

func TestParseChainResource_StandardTypes(t *testing.T) {
	obj := map[string]interface{}{
		"metadata": map[string]interface{}{"name": "c", "namespace": "ns"},
		"spec": map[string]interface{}{
			"timeoutSeconds":  int64(120),
			"suspend":         true,
			"roundTableRef":   map[string]interface{}{"name": "rt"},
			"missionRef":      map[string]interface{}{"name": "m"},
			"outputKnightRef": map[string]interface{}{"name": "gawain"},
			"steps": []interface{}{
				map[string]interface{}{"name": "s1", "knightRef": map[string]interface{}{"name": "galahad"}},
			},
		},
	}
	c := parseChainResource(obj, map[string]knightInfo{"galahad": {Domain: "security"}})
	if c.TimeoutSeconds != 120 || !c.Suspend {
		t.Errorf("timeout/suspend not read: %+v", c)
	}
	if c.RoundTableRef != "rt" || c.MissionRef != "m" || c.OutputKnight != "gawain" {
		t.Errorf("refs not read: %+v", c)
	}
	if len(c.Steps) != 1 || c.Steps[0].Knight != "galahad" || c.Steps[0].Domain != "security" {
		t.Errorf("step knightRef not read: %+v", c.Steps)
	}
}

func TestParseMissionResource_StandardTypes(t *testing.T) {
	m := parseMissionResource(map[string]interface{}{
		"metadata": map[string]interface{}{"name": "m"},
		"spec": map[string]interface{}{
			"ttlSeconds":     int64(3600),
			"timeoutSeconds": int64(600),
			"roundTableRef":  map[string]interface{}{"name": "rt"},
		},
	})
	if m.TTLSeconds != 3600 || m.TimeoutSeconds != 600 || m.RoundTableRef != "rt" {
		t.Errorf("unexpected mission: %+v", m)
	}
}

func TestBriefingMultipleDirs(t *testing.T) {
	tmp := t.TempDir()
	for _, d := range []string{"/Briefings/Daily", "/Agents/Briefings"} {
		if err := os.MkdirAll(tmp+d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	for f, c := range map[string]string{
		"/Briefings/Daily/2024-01-01.md":      "old",
		"/Agents/Briefings/2024-01-02.md":     "new",
		"/Agents/Briefings/weekly-summary.md": "x",
	} {
		if err := os.WriteFile(tmp+f, []byte(c), 0644); err != nil {
			t.Fatal(err)
		}
	}
	dirs := parseBriefingDirs(defaultBriefingDirs + ",missing/dir,../etc,/abs")
	if len(dirs) != 3 {
		t.Fatalf("unexpected dirs %v", dirs)
	}
	router := mux.NewRouter()
	router.HandleFunc("/api/briefings", briefingListHandler(tmp, dirs))
	router.HandleFunc("/api/briefings/{date}", briefingHandler(tmp, dirs))

	w := httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/briefings", nil))
	var got []briefingEntry
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(got) != 2 || got[1].Dir != "Agents/Briefings" {
		t.Fatalf("list: %d %v", w.Code, got)
	}

	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/briefings/2024-01-02", nil))
	if w.Code != 200 || w.Body.String() != "new" || w.Header().Get("X-Briefing-Dir") != "Agents/Briefings" {
		t.Fatalf("get: %d %q", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/briefings/2024-01-02?dir=Briefings/Daily", nil))
	if w.Code != 404 {
		t.Fatalf("wrong dir should 404, got %d", w.Code)
	}
	w = httptest.NewRecorder()
	router.ServeHTTP(w, httptest.NewRequest("GET", "/api/briefings/2024-01-02?dir=../..", nil))
	if w.Code != 403 {
		t.Fatalf("unconfigured dir should 403, got %d", w.Code)
	}
}

func TestBriefingListUnreadableDirWarns(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("permissions are not enforced for root")
	}
	tmp := t.TempDir()
	for _, d := range []string{"Locked", "Open"} {
		if err := os.MkdirAll(filepath.Join(tmp, d), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(tmp, "Open", "2024-01-03.md"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(tmp, "Locked"), 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(filepath.Join(tmp, "Locked"), 0755) })

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := briefingListHandler(tmp, []string{"Locked", "Missing", "Open"})
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", "/api/briefings", nil))
	var got []briefingEntry
	if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(got) != 1 || got[0].Dir != "Open" {
		t.Fatalf("got %d %v", w.Code, got)
	}
	logs := buf.String()
	if !strings.Contains(logs, "level=WARN") || !strings.Contains(logs, "dir=Locked") {
		t.Fatalf("expected warning for Locked, got %q", logs)
	}
	if strings.Contains(logs, "Missing") {
		t.Fatalf("missing dir must not warn: %q", logs)
	}
}

func TestBriefingListMissingDirs(t *testing.T) {
	h := briefingListHandler(t.TempDir(), parseBriefingDirs(defaultBriefingDirs))
	w := httptest.NewRecorder()
	h(w, httptest.NewRequest("GET", "/api/briefings", nil))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("got %d %q", w.Code, w.Body.String())
	}
}

func TestConfigTraceURLTemplate(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"unset", "", ""},
		{"valid", "https://t.example/trace/{traceId}", "https://t.example/trace/{traceId}"},
		{"javascript", "javascript:alert({traceId})", ""},
		{"no placeholder", "https://t.example/trace", ""},
		{"ftp", "ftp://t.example/{traceId}", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			configHandler("fleet-a", "ns-a", traceTemplate(c.in))(w, httptest.NewRequest("GET", "/api/config", nil))
			var resp map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
				t.Fatal(err)
			}
			got, ok := resp["traceUrlTemplate"]
			if got != c.want || (c.want == "") == ok {
				t.Errorf("traceUrlTemplate = %q (present %v), want %q", got, ok, c.want)
			}
			if resp["fleetPrefix"] != "fleet-a" {
				t.Errorf("fleetPrefix lost: %v", resp)
			}
		})
	}
}

func TestStatusTraceIDPassThrough(t *testing.T) {
	id := "0af7651916cd43dd8448eb211c80319c"
	for _, c := range []struct{ id, want string }{{id, id}, {"nothex", ""}, {id + "00", ""}, {"", ""}} {
		status := map[string]interface{}{"traceID": c.id}
		obj := map[string]interface{}{"status": status, "metadata": map[string]interface{}{"name": "x"}}
		if got := parseChainResource(obj, nil).TraceID; got != c.want {
			t.Errorf("chain traceId(%q) = %q, want %q", c.id, got, c.want)
		}
		if got := parseMissionResource(obj).TraceID; got != c.want {
			t.Errorf("mission traceId(%q) = %q, want %q", c.id, got, c.want)
		}
	}
}

func TestNewHTTPServerTimeouts(t *testing.T) {
	srv := newHTTPServer(":0", http.NewServeMux())
	if srv.ReadHeaderTimeout <= 0 || srv.IdleTimeout <= 0 {
		t.Fatalf("timeouts must be set: %v %v", srv.ReadHeaderTimeout, srv.IdleTimeout)
	}
	if srv.WriteTimeout != 0 {
		t.Fatal("WriteTimeout must stay unset (WebSocket/SSE are long-lived)")
	}
}

func TestGracefulShutdownOrder(t *testing.T) {
	var order []string
	gracefulShutdown(
		func(ctx context.Context) error { order = append(order, "shutdown"); return nil },
		func(ctx context.Context) error {
			if ctx.Err() != nil {
				t.Error("shared context expired early")
			}
			order = append(order, "flush")
			return errors.New("ignored")
		},
		time.Second,
	)
	if strings.Join(order, ",") != "shutdown,flush" {
		t.Fatalf("order = %v", order)
	}
}

type closeRecorderConn struct{ closed bool }

func (c *closeRecorderConn) Close() error { c.closed = true; return nil }

type recordingWSConn struct{ onWrite func(int, []byte) }

func (r *recordingWSConn) SetWriteDeadline(time.Time) error { return nil }
func (r *recordingWSConn) WriteMessage(mt int, d []byte) error {
	r.onWrite(mt, d)
	return nil
}

func TestCloseGoingAway(t *testing.T) {
	var got []byte
	var gotType int
	rec := &recordingWSConn{onWrite: func(mt int, d []byte) { gotType, got = mt, d }}
	ws := &wsWriter{conn: rec}
	c := &closeRecorderConn{}
	closeGoingAway(ws, c)
	if !c.closed || gotType != websocket.CloseMessage || len(got) < 2 || int(got[0])<<8|int(got[1]) != websocket.CloseGoingAway {
		t.Fatalf("closed=%v type=%d payload=%v", c.closed, gotType, got)
	}
}

// TestWSShutdownSendsGoingAway runs the real handler behind httptest with a
// real WebSocket client and checks that graceful shutdown waits for the 1001
// close frame to be sent.
func TestWSShutdownSendsGoingAway(t *testing.T) {
	conn, _ := startCardsNATS(t)
	oldNC, oldLife := nc, wsLife
	nc, wsLife = conn, newWSLifecycle()
	t.Cleanup(func() { nc, wsLife = oldNC, oldLife })

	src := &tableSource{ttl: time.Hour, now: time.Now, ok: true}
	srv := httptest.NewServer(wsHandler(src, nil, nil, nil, nil, nil))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	gotCode := make(chan int, 1)
	go func() {
		for {
			if _, _, err := c.ReadMessage(); err != nil {
				code := -1
				var ce *websocket.CloseError
				if errors.As(err, &ce) {
					code = ce.Code
				}
				gotCode <- code
				return
			}
		}
	}()
	time.Sleep(100 * time.Millisecond) // let the handler register

	gracefulShutdown(func(ctx context.Context) error {
		wsLife.begin()
		wsLife.wait(ctx)
		return nil
	}, func(context.Context) error { return nil }, 5*time.Second)

	select {
	case code := <-gotCode:
		if code != websocket.CloseGoingAway {
			t.Fatalf("close code = %d, want 1001", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no close frame received")
	}
}
