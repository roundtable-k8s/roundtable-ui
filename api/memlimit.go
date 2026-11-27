package main

import (
	"context"
	"log/slog"
	"os"
	"runtime/debug"
	"strconv"
	"strings"
)

// Soft memory limit from the container limit (#471). Without GOMEMLIMIT the
// garbage collector only looks at heap growth (GOGC), so a start-up burst can
// cross the cgroup limit and get the process OOM-killed before a collection
// runs. setMemoryLimitFromCgroup sets the Go soft limit to memLimitFraction of
// the cgroup memory limit unless GOMEMLIMIT is already set.

// memLimitFraction leaves headroom for non-heap memory (stacks, runtime, cgo).
const memLimitFraction = 0.9

// cgroupMemoryFiles are the cgroup v2 and v1 memory limit files.
var cgroupMemoryFiles = []string{
	"/sys/fs/cgroup/memory.max",
	"/sys/fs/cgroup/memory/memory.limit_in_bytes",
}

// parseCgroupMemoryLimit parses a cgroup memory limit file; ok is false for
// "max", an unset v1 limit (a huge value) or garbage.
func parseCgroupMemoryLimit(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s == "max" {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	// cgroup v1 reports "no limit" as a page-aligned value near MaxInt64.
	if err != nil || n <= 0 || n >= 1<<62 {
		return 0, false
	}
	return n, true
}

// memoryLimitFor returns the soft limit for a cgroup limit.
func memoryLimitFor(cgroupLimit int64) int64 {
	return int64(float64(cgroupLimit) * memLimitFraction)
}

// setMemoryLimitFromCgroup applies the soft limit; it returns the limit set
// (0 when none was).
func setMemoryLimitFromCgroup(files []string) int64 {
	if os.Getenv("GOMEMLIMIT") != "" {
		return 0
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		limit, ok := parseCgroupMemoryLimit(string(b))
		if !ok {
			return 0
		}
		soft := memoryLimitFor(limit)
		debug.SetMemoryLimit(soft)
		slog.InfoContext(context.Background(), "Go memory limit set from cgroup", "cgroupLimitBytes", limit, "goMemLimitBytes", soft)
		return soft
	}
	return 0
}
