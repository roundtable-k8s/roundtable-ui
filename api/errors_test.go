package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation/field"
	dynfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestJsonErrorWritesJSONBody(t *testing.T) {
	w := httptest.NewRecorder()
	jsonError(w, "Knight not found", http.StatusNotFound)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	if nosniff := w.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", nosniff)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", w.Body.String(), err)
	}
	if body["error"] != "Knight not found" {
		t.Errorf("error = %q, want %q", body["error"], "Knight not found")
	}
}

func TestAuthRejectionIsJSON(t *testing.T) {
	t.Setenv("DASHBOARD_API_KEY", "secret")
	h := authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/fleet", nil)
	h.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("body %q is not JSON: %v", w.Body.String(), err)
	}
	if body["error"] != "Unauthorized" {
		t.Errorf("error = %q, want Unauthorized", body["error"])
	}
}

func TestMissionCreateDeleteK8sErrors(t *testing.T) {
	router := setupTestRouter()
	fdc := dynClient.(*dynfake.FakeDynamicClient)
	gr := schema.GroupResource{Group: "ai.roundtable.io", Resource: "missions"}
	react := func(verb string, err error) {
		fdc.PrependReactor(verb, "missions", func(k8stesting.Action) (bool, runtime.Object, error) { return true, nil, err })
	}
	body := `{"name":"m1","objective":"x"}`

	cases := []struct {
		name   string
		verb   string
		err    error
		method string
		target string
		code   int
		msg    string
	}{
		{"exists", "create", apierrors.NewAlreadyExists(gr, "m1"), "POST", "/api/missions", 409, "A mission with this name already exists"},
		{"forbidden", "create", apierrors.NewForbidden(gr, "m1", errors.New("secret detail")), "POST", "/api/missions", 403, "Not allowed to create this mission"},
		{"invalid", "create", apierrors.NewInvalid(schema.GroupKind{Group: "ai.roundtable.io", Kind: "Mission"}, "m1", field.ErrorList{field.Invalid(field.NewPath("spec", "ttlSeconds"), 1, "too small")}), "POST", "/api/missions", 422, "spec.ttlSeconds"},
		{"generic", "create", errors.New("boom internal"), "POST", "/api/missions", 500, "Failed to create mission"},
		{"not found", "delete", apierrors.NewNotFound(gr, "m1"), "DELETE", "/api/missions/m1", 404, "Mission not found"},
		{"delete generic", "delete", errors.New("boom internal"), "DELETE", "/api/missions/m1", 500, "Failed to delete mission"},
	}
	for _, c := range cases {
		fdc.ReactionChain = nil
		react(c.verb, c.err)
		w := doReq(router, c.method, c.target, body)
		if w.Code != c.code || !strings.Contains(w.Body.String(), c.msg) {
			t.Errorf("%s: got %d %s", c.name, w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "boom") || strings.Contains(w.Body.String(), "secret detail") {
			t.Errorf("%s: raw error leaked: %s", c.name, w.Body.String())
		}
	}
	fdc.ReactionChain = nil
}

func TestObjectiveAndMessageCountCharacters(t *testing.T) {
	router := setupTestRouter()
	mk := func(n int) string {
		b, _ := json.Marshal(map[string]string{"name": "len-" + strconv.Itoa(n), "objective": strings.Repeat("字", n)})
		return string(b)
	}
	if w := doReq(router, "POST", "/api/missions", mk(1000)); w.Code != 201 {
		t.Errorf("1000 runes: got %d %s", w.Code, w.Body.String())
	}
	if w := doReq(router, "POST", "/api/missions", mk(1001)); w.Code != 400 {
		t.Errorf("1001 runes: got %d", w.Code)
	}
	if w := doReq(router, "POST", "/api/missions", `{"name":"ws","objective":"  \n "}`); w.Code != 400 {
		t.Errorf("whitespace objective: got %d", w.Code)
	}

	f := &fakeGateway{}
	srv := f.server(t)
	g := &gatewayClient{baseURL: srv.URL, http: srv.Client()}
	chat, disp := chatRouter(g), dispatchRouter(g)
	chatBody := func(n int) string {
		b, _ := json.Marshal(map[string]string{"message": strings.Repeat("字", n)})
		return string(b)
	}
	dispBody := func(n int) string {
		b, _ := json.Marshal(map[string]string{"knight": "galahad", "task": strings.Repeat("字", n)})
		return string(b)
	}
	if w := doReq(chat, "POST", "/api/chat/galahad", chatBody(3000)); w.Code != 202 {
		t.Errorf("chat 3000: got %d", w.Code)
	}
	if w := doReq(chat, "POST", "/api/chat/galahad", chatBody(10001)); w.Code != 400 {
		t.Errorf("chat 10001: got %d", w.Code)
	}
	if w := doReq(chat, "POST", "/api/chat/galahad", `{"message":"  \t"}`); w.Code != 400 {
		t.Errorf("chat whitespace: got %d", w.Code)
	}
	if w := doReq(disp, "POST", "/api/tasks/dispatch", dispBody(3000)); w.Code != 202 {
		t.Errorf("dispatch 3000: got %d", w.Code)
	}
	if w := doReq(disp, "POST", "/api/tasks/dispatch", dispBody(10001)); w.Code != 400 {
		t.Errorf("dispatch 10001: got %d", w.Code)
	}
	if w := doReq(disp, "POST", "/api/tasks/dispatch", `{"knight":"galahad","task":" "}`); w.Code != 400 {
		t.Errorf("dispatch whitespace: got %d", w.Code)
	}
}

func TestAuthKeyHandling(t *testing.T) {
	t.Setenv("DASHBOARD_API_KEY", "secret")
	h := authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	cases := []struct {
		name, method, target, auth, body string
		want                             int
	}{
		{"bearer ok", "GET", "/api/fleet", "Bearer secret", "", 200},
		{"bearer wrong", "GET", "/api/fleet", "Bearer nope", "", 401},
		{"query ok on ws", "GET", "/api/ws?api_key=secret", "", "", 200},
		{"query wrong on ws", "GET", "/api/ws?api_key=nope", "", "", 401},
		{"query rejected on fleet", "GET", "/api/fleet?api_key=secret", "", "", 401},
		{"login ok", "POST", "/api/auth/login", "", `{"apiKey":"secret"}`, 200},
		{"login wrong", "POST", "/api/auth/login", "", `{"apiKey":"nope"}`, 401},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(c.method, c.target, strings.NewReader(c.body))
			if c.auth != "" {
				req.Header.Set("Authorization", c.auth)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != c.want {
				t.Errorf("status = %d, want %d", w.Code, c.want)
			}
		})
	}
}

func TestKeyEqual(t *testing.T) {
	if !keyEqual("a", "a") || keyEqual("a", "b") || keyEqual("", "a") || keyEqual("ab", "a") {
		t.Error("keyEqual wrong")
	}
}
