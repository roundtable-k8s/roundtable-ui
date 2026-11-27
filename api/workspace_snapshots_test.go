package main

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestBuildWorkspaceSnapshots(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]interface{}{
		"status": map[string]interface{}{
			"workspace": map[string]interface{}{
				"snapshots": []interface{}{
					map[string]interface{}{"name": "b", "createdAt": "2026-02-01T00:00:00Z", "readyToUse": false},
					"junk",
					map[string]interface{}{"createdAt": "2026-01-01T00:00:00Z"},
					map[string]interface{}{"name": "a", "createdAt": "2026-01-01T00:00:00Z", "readyToUse": true},
				},
			},
			"conditions": []interface{}{
				map[string]interface{}{"type": "Ready", "status": "True"},
				map[string]interface{}{"type": "WorkspaceSnapshots", "status": "False", "reason": "Pending"},
			},
		},
	}}
	got := buildWorkspaceSnapshots(obj)
	if len(got) != 2 || got[0].Name != "a" || !got[0].ReadyToUse || got[1].Name != "b" || got[1].ReadyToUse {
		t.Fatalf("unexpected snapshots: %+v", got)
	}
	c := buildWorkspaceSnapshotsCondition(obj)
	if c == nil || c.Status != "False" || c.Reason != "Pending" {
		t.Fatalf("unexpected condition: %+v", c)
	}
	empty := &unstructured.Unstructured{Object: map[string]interface{}{}}
	if buildWorkspaceSnapshots(empty) != nil || buildWorkspaceSnapshotsCondition(empty) != nil {
		t.Fatal("expected nothing for a knight without snapshots")
	}
}
