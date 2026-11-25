package main

import (
	"context"
	"testing"
	"time"
)

func TestTableCacheGetNotBlockedBySlowLookup(t *testing.T) {
	release := make(chan struct{})
	calls := 0
	c := newTableCache(func(ctx context.Context) map[string]string {
		calls++
		if calls == 1 {
			return map[string]string{"a": "personal"}
		}
		select {
		case <-release:
		case <-ctx.Done():
		}
		return map[string]string{"a": "work"}
	}, time.Hour, 50*time.Millisecond)
	c.refresh()
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() { c.refresh(); close(finished) }()
	start := time.Now()
	if got := c.get()["a"]; got != "personal" {
		t.Fatalf("got %q", got)
	}
	if time.Since(start) > 20*time.Millisecond {
		t.Fatal("get blocked by slow lookup")
	}
	<-finished // lookup bounded by timeout
	close(done)
	close(release)
	if got := c.get()["a"]; got != "work" {
		t.Fatalf("got %q after refresh", got)
	}
}

func TestTableCacheKeepsOldOnEmpty(t *testing.T) {
	n := 0
	c := newTableCache(func(context.Context) map[string]string {
		n++
		if n == 1 {
			return map[string]string{"a": "x"}
		}
		return map[string]string{}
	}, time.Hour, time.Second)
	c.refresh()
	c.refresh()
	if c.get()["a"] != "x" {
		t.Fatal("lost cache on empty lookup")
	}
}
