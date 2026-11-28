package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
)

func TestScheduleManifestUpstreamMapping(t *testing.T) {
	cases := []struct {
		name, body, retryAfter, wantSub, wantRA string
		status, want                            int
	}{
		{"401", `{"error":"unauthorized"}`, "", "GATEWAY_TOKEN", "", 401, 502},
		{"403 auth", `{"error":"forbidden: nope"}`, "", "GATEWAY_TOKEN", "", 403, 502},
		{"404 passes", `{"error":"no such schedule"}`, "", "no such schedule", "", 404, 404},
		{"429 Retry-After", `{"error":"slow"}`, "9", "slow", "9", 429, 429},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeGateway{handler: func(_ gwCall, w http.ResponseWriter) {
				if c.retryAfter != "" {
					w.Header().Set("Retry-After", c.retryAfter)
				}
				w.WriteHeader(c.status)
				io.WriteString(w, c.body)
			}}
			srv := f.server(t)
			r := scheduleRouter(&gatewayClient{baseURL: srv.URL, http: srv.Client()})
			w := doReq(r, "GET", "/api/schedules/roundtable/x/manifest", "")
			if w.Code != c.want || !strings.Contains(w.Body.String(), c.wantSub) {
				t.Fatalf("got %d %s", w.Code, w.Body)
			}
			if got := w.Header().Get("Retry-After"); got != c.wantRA {
				t.Errorf("Retry-After = %q, want %q", got, c.wantRA)
			}
		})
	}
}

func TestUpstreamErrorDeadlineIsNeutral(t *testing.T) {
	for _, err := range []error{context.DeadlineExceeded, fmt.Errorf("list: %w", context.DeadlineExceeded)} {
		w := httptest.NewRecorder()
		upstreamError(w, httptest.NewRequest("GET", "/x", nil), err, "chains")
		if w.Code != 502 || strings.Contains(w.Body.String(), "NATS") || strings.Contains(w.Body.String(), "Kubernetes") {
			t.Errorf("got %d %s", w.Code, w.Body)
		}
	}
}

func TestK8sErrorStatusNetworkErrorIs502(t *testing.T) {
	op := &net.OpError{Op: "dial", Net: "tcp", Err: errors.New("connection refused")}
	for _, err := range []error{
		&url.Error{Op: "Get", URL: "https://k8s", Err: op},
		&net.DNSError{Err: "no such host", Name: "k8s", IsNotFound: true},
	} {
		if code, msg := k8sErrorStatus(err, "read", "chains"); code != 502 || msg != "Kubernetes API unavailable, try again" {
			t.Errorf("%v: got %d %q", err, code, msg)
		}
	}
}

// TestListHandlerAnswers502WhenKubernetesBlocksOrIsDown runs a list handler
// against an API server that never answers and one that refuses connections.
func TestListHandlerAnswers502WhenKubernetesBlocksOrIsDown(t *testing.T) {
	release := make(chan struct{})
	blocking := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer blocking.Close()
	defer close(release)
	dead := httptest.NewServer(http.NotFoundHandler())
	deadURL := dead.URL
	dead.Close()

	oldD, oldT, oldS := dynClient, k8sRequestTimeout, listCacheSyncTimeout
	k8sRequestTimeout, listCacheSyncTimeout = 150*time.Millisecond, 50*time.Millisecond
	t.Cleanup(func() {
		dynClient, k8sRequestTimeout, listCacheSyncTimeout = oldD, oldT, oldS
		resetListCache()
	})

	for name, host := range map[string]string{"blocking": blocking.URL, "refused": deadURL} {
		t.Run(name, func(t *testing.T) {
			resetListCache()
			dc, err := dynamic.NewForConfig(&rest.Config{Host: host})
			if err != nil {
				t.Fatal(err)
			}
			dynClient = dc
			r := mux.NewRouter()
			r.HandleFunc("/api/chains", chainsHandler("roundtable", nil))
			w := doReq(r, "GET", "/api/chains", "")
			if w.Code != http.StatusBadGateway {
				t.Fatalf("got %d %s, want 502", w.Code, w.Body)
			}
			if strings.Contains(w.Body.String(), "NATS") {
				t.Errorf("message blames NATS: %s", w.Body)
			}
		})
	}
}
