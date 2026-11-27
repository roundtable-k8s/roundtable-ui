package main

import (
	"context"
	"testing"
	"time"
)

func TestTableCacheGetNotBlockedBySlowLookup(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	calls := 0
	c := newTableCache(func(ctx context.Context) map[string]string {
		calls++
		if calls == 1 {
			return map[string]string{"a": "personal"}
		}
		close(started)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return map[string]string{"a": "work"}
	}, time.Hour, time.Minute)
	c.refresh()
	finished := make(chan struct{})
	go func() { c.refresh(); close(finished) }()
	<-started // the slow lookup is now in flight
	got := make(chan string, 1)
	go func() { got <- c.get()["a"] }()
	select {
	case v := <-got:
		if v != "personal" {
			t.Fatalf("got %q", v)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("get blocked by slow lookup")
	}
	close(release)
	<-finished
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

func TestTableCacheRunRefreshesWithoutWaitingForTick(t *testing.T) {
	c := newTableCache(func(ctx context.Context) map[string]string {
		return map[string]string{"a": "work"}
	}, time.Hour, time.Second)
	if c.get() != nil {
		t.Fatal("get must be nil before the first refresh")
	}
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() { c.run(done); close(finished) }()
	deadline := time.Now().Add(2 * time.Second)
	for c.get() == nil {
		if time.Now().After(deadline) {
			t.Fatal("run did not refresh before the first tick")
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(done)
	<-finished
}

func TestTableCacheRunDoesNotBlockCaller(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{})
	c := newTableCache(func(ctx context.Context) map[string]string {
		close(started)
		<-release
		return map[string]string{"t": "p"}
	}, time.Hour, time.Second)
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() { c.run(done); close(finished) }()
	// The first lookup is in flight (blocked) yet get() returns immediately, nil.
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("run never started the first lookup")
	}
	if c.get() != nil {
		t.Fatal("get() non-nil before the first lookup finished")
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for c.get() == nil {
		if time.Now().After(deadline) {
			t.Fatal("cache never populated by run")
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(done)
	<-finished
}
