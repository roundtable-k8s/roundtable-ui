package main

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Internal-state metrics (#499). Everything here is read at scrape time, so
// no request path pays for it; each collector takes the lock of the state it
// reads only briefly.

// newBuildInfoCollector exports roundtable_ui_build_info{version,commit,go_version} 1.
func newBuildInfoCollector(v versionInfo) prometheus.Collector {
	g := prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name:        "roundtable_ui_build_info",
		Help:        "Build information of the running dashboard API; the value is always 1.",
		ConstLabels: prometheus.Labels{"version": v.Version, "commit": v.Commit, "go_version": v.GoVersion},
	}, func() float64 { return 1 })
	return g
}

var runningTasksDesc = prometheus.NewDesc("roundtable_ui_running_tasks",
	"Tasks held by the in-flight registry, by status (running, stale, lost).",
	[]string{"status"}, nil)

// runningTasksCollector counts the in-flight registry by status.
type runningTasksCollector struct{ reg *runningRegistry }

func (c runningTasksCollector) Describe(ch chan<- *prometheus.Desc) { ch <- runningTasksDesc }

func (c runningTasksCollector) Collect(ch chan<- prometheus.Metric) {
	counts := c.reg.countByStatus()
	for _, s := range []string{runningStatusRunning, runningStatusStale, runningStatusLost} {
		ch <- prometheus.MustNewConstMetric(runningTasksDesc, prometheus.GaugeValue, float64(counts[s]), s)
	}
}

var (
	listCacheObjectsDesc = prometheus.NewDesc("roundtable_ui_list_cache_objects",
		"Objects held in a watch-backed list cache, by resource.", []string{"resource"}, nil)
	listCacheSyncedDesc = prometheus.NewDesc("roundtable_ui_list_cache_synced",
		"1 when the watch-backed list cache of a resource has completed its first sync, else 0.", []string{"resource"}, nil)
)

// listCacheCollector walks listCacheInformers at scrape time. A resource
// cached for several clients or namespaces is summed (objects) / ANDed (synced).
type listCacheCollector struct{}

func (listCacheCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- listCacheObjectsDesc
	ch <- listCacheSyncedDesc
}

func (listCacheCollector) Collect(ch chan<- prometheus.Metric) {
	objects := map[string]float64{}
	synced := map[string]float64{}
	listCacheMu.Lock()
	for k, e := range listCacheInformers {
		res := k.gvr.Resource
		objects[res] += float64(len(e.inf.GetStore().ListKeys()))
		s := 0.0
		if e.inf.HasSynced() {
			s = 1
		}
		if prev, ok := synced[res]; !ok || s < prev {
			synced[res] = s
		}
	}
	listCacheMu.Unlock()
	for res, n := range objects {
		ch <- prometheus.MustNewConstMetric(listCacheObjectsDesc, prometheus.GaugeValue, n, res)
		ch <- prometheus.MustNewConstMetric(listCacheSyncedDesc, prometheus.GaugeValue, synced[res], res)
	}
}

// newChainWatchSubscribersGauge exports the number of chain-watch subscribers.
func newChainWatchSubscribersGauge(c *chainWatcher) prometheus.Collector {
	return prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "roundtable_ui_chain_watch_subscribers",
		Help: "WebSocket subscribers of the live chain watcher.",
	}, func() float64 {
		c.mu.Lock()
		defer c.mu.Unlock()
		return float64(len(c.subs))
	})
}
