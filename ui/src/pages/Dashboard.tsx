import { apiGet, apiGetWithTotal } from '../lib/api'
import { GlanceStrip } from '../components/GlanceStrip'
import { CHAIN_LIST_LIMIT, type KeyedTotal, totalFor, truncationNote } from '../lib/chainTotal'
import { useState, useEffect, useMemo, useRef } from 'react'
import { Crown, Activity, DollarSign, Zap, AlertTriangle, Link2, ArrowRight, TrendingUp, Calendar, ChevronDown, ChevronRight, Loader, Download } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTableFilter } from '../hooks/useTableFilter'
import { inTable, withTable } from '../lib/tables'
import { useFleet } from '../hooks/useFleet'
import { fetchWithTimeout } from '../hooks/useKnightSession'
import { useWebSocket, eventKey } from '../hooks/useWebSocket'
import { useRunning } from '../hooks/useRunning'
import { countByStatus } from '../lib/running'
import { getKnightConfig, domainIndex } from '../lib/knights'
import { parseEvent, eventListKeys, uniqueKeys } from '../lib/events'
import { PageHeader, StatCard, PhaseBadge, ProgressBar, EmptyState, ErrorBanner, Spinner } from '../components/ui'
import { FirstRun } from '../components/FirstRun'
import { formatCost, formatDay, formatTimestamp, until } from '../lib/format'
import { costByChain } from '../lib/chainCost'
import { CostTag } from '../components/CostTag'
import { costPanelCsv } from '../lib/cost'
import { toCsv } from '../lib/csv'

import type { Chain } from '../lib/types'

interface CostEntry {
  knight: string
  cost: number
  timestamp: string
  taskId: string
  success: boolean
}

/** The reader's local calendar day as YYYY-MM-DD: sortable and locale-independent. */
function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const SESSION_COST_REFRESH_MS = 2000

/** Fetch session introspection cost for each knight; knights without session stats are omitted. */
async function fetchSessionCosts(names: string[]): Promise<Record<string, number>> {
  const results = await Promise.allSettled(
    names.map(name =>
      fetchWithTimeout(`/api/fleet/${encodeURIComponent(name)}/session?type=stats`).then(r => {
        if (!r || !r.ok) throw new Error('introspect unavailable')
        return r.json()
      })
    )
  )
  const perKnight: Record<string, number> = {}
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value?.session?.cost) perKnight[names[i]] = r.value.session.cost
  })
  return perKnight
}

export const DASHBOARD_CHAINS_URL = `/api/chains?limit=${CHAIN_LIST_LIMIT}`

const FLEET_PANEL_MAX = 12

export function DashboardPage({ defaultCostExpanded = false }: { defaultCostExpanded?: boolean } = {}) {
  const { table } = useTableFilter()
  const { knights, loading: fleetLoading, error: fleetError } = useFleet()
  const { events, connected } = useWebSocket()
  const runningAll = useRunning()
  const running = useMemo(
    () => ({ ...runningAll, tasks: new Map([...runningAll.tasks].filter(([, t]) => inTable(table, t.table))) }),
    [runningAll, table],
  )
  const [chains, setChains] = useState<Chain[]>([])
  const [chainsLoading, setChainsLoading] = useState(true)
  const [chainsError, setChainsError] = useState<string | null>(null)
  const [storedTotal, setStoredTotal] = useState<KeyedTotal | null>(null)
  const chainTotal = totalFor(storedTotal, withTable(DASHBOARD_CHAINS_URL, table))
  const [sessionCosts, setSessionCosts] = useState<{ perKnight: Record<string, number> }>({ perKnight: {} })
  const [costExpanded, setCostExpanded] = useState(defaultCostExpanded)
  const [timeRange, setTimeRange] = useState<'day' | 'week' | 'month'>('week')

  useEffect(() => {
    // The list is paginated (default 100, #275); ask for the maximum so no
    // chain is dropped. Items are slim, which is all this panel needs.
    let alive = true
    apiGetWithTotal<Chain[]>(withTable(DASHBOARD_CHAINS_URL, table)).then(({ items: data, total }) => {
      if (!alive) return
      setChains(data)
      setChainsError(null)
      setChainsLoading(false)
      setStoredTotal({ url: withTable(DASHBOARD_CHAINS_URL, table), total })
    }).catch((e) => {
      if (!alive) return
      // keep any stale chains; just say the refresh failed
      setChainsError(e instanceof Error ? e.message : 'Unknown error')
      setChainsLoading(false)
    })
    return () => { alive = false }
  }, [table])

  // Fetch cumulative session costs for every listed knight that has not been
  // asked yet, so knights that appear later (scale-up, new table) are counted.
  const sessionCostsRequested = useRef<Set<string>>(new Set())
  useEffect(() => {
    const fresh = knights.map((k) => k.name).filter((n) => !sessionCostsRequested.current.has(n))
    if (fresh.length === 0) return
    fresh.forEach((n) => sessionCostsRequested.current.add(n))
    fetchSessionCosts(fresh).then((got) => {
      if (Object.keys(got).length === 0) return
      setSessionCosts((prev) => ({ perKnight: { ...prev.perKnight, ...got } }))
    })
  }, [knights])

  // Session cost is cumulative and only fetched at load, so tasks finishing
  // while the dashboard is open would go uncounted for knights that have
  // session stats (live costs only backfill knights without them). When a
  // live result arrives for such a knight, re-fetch just that knight's session
  // cost, debounced so a burst of results coalesces into one fetch per knight.
  const sessionKnightsRef = useRef<Set<string>>(new Set())
  const fleetDomains = useMemo(() => domainIndex(knights), [knights])
  const fleetNames = useMemo(() => new Set(knights.map((k) => k.name)), [knights])
  // Only knights in the current fleet list (the selected table) count.
  const listedSessionCosts = useMemo(
    () => Object.fromEntries(Object.entries(sessionCosts.perKnight).filter(([n]) => fleetNames.has(n))),
    [sessionCosts, fleetNames],
  )
  sessionKnightsRef.current = new Set(Object.keys(listedSessionCosts))
  const seenResults = useRef<Set<string>>(new Set())
  const pendingRefresh = useRef<Set<string>>(new Set())
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    for (const e of events) {
      if (e.type !== 'result' || !e.live) continue
      const key = eventKey(e)
      if (seenResults.current.has(key)) continue
      seenResults.current.add(key)
      const { knight } = parseEvent(e)
      if (knight && sessionKnightsRef.current.has(knight)) pendingRefresh.current.add(knight)
    }
    if (pendingRefresh.current.size === 0 || refreshTimer.current) return
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      const names = [...pendingRefresh.current]
      pendingRefresh.current.clear()
      fetchSessionCosts(names).then((fresh) => {
        if (Object.keys(fresh).length === 0) return
        setSessionCosts((prev) => {
          return { perKnight: { ...prev.perKnight, ...fresh } }
        })
      })
    }, SESSION_COST_REFRESH_MS)
  }, [events])
  useEffect(() => () => { if (refreshTimer.current) clearTimeout(refreshTimer.current) }, [])

  const stats = useMemo(() => {
    let totalCost = 0
    let totalTasks = 0
    let totalResults = 0
    let failures = 0
    const knightCosts: Record<string, number> = {}

    for (const e of events) {
      if (e.type === 'task') totalTasks++
      if (e.type !== 'result') continue
      totalResults++

      const { knight, data } = parseEvent(e)

      if (data.success === false) failures++
      const cost = typeof data.cost === 'number' ? data.cost : 0
      totalCost += cost

      if (knight) knightCosts[knight] = (knightCosts[knight] || 0) + cost
    }

    // Session introspection cost is cumulative and already includes any task
    // that also arrived as a live result event — adding both double-counts.
    // Session cost is authoritative per knight; live WS costs only fill in
    // for knights that didn't report session stats.
    const mergedCosts: Record<string, number> = { ...listedSessionCosts }
    let mergedTotal = Object.values(mergedCosts).reduce((a, b) => a + b, 0)
    for (const [name, cost] of Object.entries(knightCosts)) {
      if (!(name in mergedCosts)) {
        mergedCosts[name] = cost
        mergedTotal += cost
      }
    }

    const topKnights = Object.entries(mergedCosts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    return { totalCost: mergedTotal, totalTasks, totalResults, failures, topKnights }
  }, [events, listedSessionCosts])

  // Cost breakdown data for collapsible panel
  const costEntries = useMemo((): CostEntry[] => {
    const entries: CostEntry[] = []
    for (const event of events) {
      if (event.type !== 'result') continue
      const { knight, taskId, data } = parseEvent(event)
      const cost = typeof data.cost === 'number' ? data.cost : 0
      if (cost <= 0) continue
      entries.push({
        knight: knight || 'unknown',
        cost,
        timestamp: event.timestamp,
        taskId,
        success: data.success !== false,
      })
    }
    return entries
  }, [events])

  const filteredCostEntries = useMemo(() => {
    const now = Date.now()
    const cutoff = timeRange === 'day' ? 24 * 60 * 60 * 1000
      : timeRange === 'week' ? 7 * 24 * 60 * 60 * 1000
      : 30 * 24 * 60 * 60 * 1000
    return costEntries.filter(e => now - new Date(e.timestamp).getTime() <= cutoff)
  }, [costEntries, timeRange])

  const costPanelData = useMemo(() => {
    const totalCost = filteredCostEntries.reduce((sum, e) => sum + e.cost, 0)
    const byKnight: Record<string, { cost: number; tasks: number; failures: number }> = {}
    for (const entry of filteredCostEntries) {
      if (!byKnight[entry.knight]) byKnight[entry.knight] = { cost: 0, tasks: 0, failures: 0 }
      byKnight[entry.knight].cost += entry.cost
      byKnight[entry.knight].tasks++
      if (!entry.success) byKnight[entry.knight].failures++
    }
    const costByKnight = Object.entries(byKnight)
      .map(([knight, s]) => ({ knight, ...s }))
      .sort((a, b) => b.cost - a.cost)

    const days: Record<string, number> = {}
    for (const entry of filteredCostEntries) {
      const day = localDayKey(new Date(entry.timestamp))
      days[day] = (days[day] || 0) + entry.cost
    }
    const dailyCosts = Object.entries(days)
      .map(([day, cost]) => ({ day, date: formatDay(day), cost }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
      .slice(-7)

    const topTasks = [...filteredCostEntries].sort((a, b) => b.cost - a.cost).slice(0, 10)

    return { totalCost, costByKnight, dailyCosts, topTasks }
  }, [filteredCostEntries])

  const chainsNote = truncationNote(chains.length, chainTotal)

  // Cost by chain: run copies of one template share a row (#515).
  const chainCostRows = useMemo(() => {
    const days = timeRange === 'day' ? 1 : timeRange === 'week' ? 7 : 30
    return costByChain(chains, Date.now() - days * 24 * 60 * 60 * 1000)
  }, [chains, timeRange])
  // The panel's figures as a CSV file. Built from the same data the panel shows.
  function downloadCostCsv() {
    const csv = toCsv(costPanelCsv(costPanelData))
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `roundtable-costs-${timeRange}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const runningCounts = useMemo(() => countByStatus(running.tasks.values()), [running.tasks])
  const runningTotal = runningCounts.running + runningCounts.stale + runningCounts.lost
  const runningDetail = [
    runningCounts.stale > 0 ? `${runningCounts.stale} stale` : '',
    runningCounts.lost > 0 ? `${runningCounts.lost} lost` : '',
  ].filter(Boolean).join(' • ') || undefined

  const fleetPending = fleetLoading && knights.length === 0 && !fleetError
  const online = knights.filter(k => k.status === 'online').length
  const fleetTiles = [...knights].sort((x, y) => x.name.localeCompare(y.name)).slice(0, FLEET_PANEL_MAX)
  // Empty fleet from a successful request: explain how to create the first knight.
  const fleetFirstRun = !fleetLoading && !fleetError && knights.length === 0
  const runningChains = chains.filter(c => c.phase === 'Running' || c.phase === 'StepRunning')

  return (
    <div>
      <PageHeader
        icon={Crown}
        title="Command Center"
        subtitle={<>Fleet status at a glance • {connected ? '🟢 Live' : '🔴 Disconnected'}</>}
      />

      {(fleetError || chainsError) && (
        <div className="mb-6 space-y-2">
          {fleetError && <ErrorBanner>Failed to load fleet: {fleetError}</ErrorBanner>}
          {chainsError && <ErrorBanner>Failed to load chains: {chainsError}</ErrorBanner>}
        </div>
      )}
      {(fleetPending || (chainsLoading && !chainsError)) && (
        <div className="mb-6 flex items-center gap-2 text-sm text-gray-400" role="status">
          <Spinner size="sm" /> Loading…
        </div>
      )}

      <GlanceStrip knights={fleetError || (fleetLoading && knights.length === 0) ? null : knights} />

      {/* Top-level metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-8">
        <StatCard label="Knights Online" value={fleetPending ? '…' : `${online}/${knights.length}`} color="text-green-400" icon={<Zap className="w-5 h-5" />} />
        <Link to="/running" aria-label="Running tasks" className="block rounded-xl hover:ring-1 hover:ring-roundtable-gold/40">
          <StatCard
            label="Running Tasks"
            value={running.unavailable ? '—' : runningTotal}
            color={runningCounts.lost > 0 ? 'text-red-400' : runningCounts.stale > 0 ? 'text-yellow-400' : runningTotal > 0 ? 'text-blue-400' : 'text-gray-400'}
            icon={<Loader className="w-5 h-5" />}
            detail={runningDetail}
          />
        </Link>
        <StatCard label="Tasks Dispatched" value={stats.totalTasks} color="text-blue-400" icon={<Activity className="w-5 h-5" />} />
        <StatCard label="Completed" value={stats.totalResults} color="text-green-400" />
        <StatCard label="Failures" value={stats.failures} color={stats.failures > 0 ? 'text-red-400' : 'text-gray-400'} icon={stats.failures > 0 ? <AlertTriangle className="w-5 h-5" /> : undefined} />
        <StatCard label="Session Cost" value={formatCost(stats.totalCost)} color="text-roundtable-gold" icon={<DollarSign className="w-5 h-5" />} />
        <StatCard label="Active Chains" value={runningChains.length} color={runningChains.length > 0 ? 'text-blue-400' : 'text-gray-400'} icon={<Link2 className="w-5 h-5" />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Fleet Overview */}
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">🏰 Fleet</h2>
            <Link to="/fleet" className="text-xs text-roundtable-gold hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {fleetTiles.length === 0 ? (
            fleetFirstRun ? <FirstRun /> : <EmptyState title="No knights found" sub="The fleet API returned no knights." />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {fleetTiles.map(knight => {
                const cfg = getKnightConfig(knight.name)
                const isOnline = knight.status === 'online'
                return (
                  <div key={knight.name} className={`flex items-center gap-2 px-3 py-2 rounded-lg ${isOnline ? 'bg-green-500/5' : 'bg-gray-500/5'}`}>
                    <span className={`w-2 h-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-600'}`} />
                    <span className="text-sm">{cfg.emoji}</span>
                    <span className={`text-sm truncate ${isOnline ? 'text-gray-300' : 'text-gray-600'}`}>{knight.name}</span>
                    <span className={`ml-auto text-xs ${isOnline ? 'text-green-400' : 'text-gray-500'}`}>{isOnline ? 'online' : 'offline'}</span>
                  </div>
                )
              })}
            </div>
          )}
          {knights.length > FLEET_PANEL_MAX && (
            <p className="mt-2 text-xs text-gray-500">+{knights.length - FLEET_PANEL_MAX} more — see View all</p>
          )}
        </div>

        {/* Top Spenders */}
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">💰 Cost by Knight</h2>
            <Link to="/sessions" className="text-xs text-roundtable-gold hover:underline flex items-center gap-1">
              Details <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {stats.topKnights.length === 0 ? (
            <EmptyState title="No cost data yet" />
          ) : (
            <div className="space-y-3">
              {stats.topKnights.map(([name, cost]) => {
                const cfg = getKnightConfig(name)
                const maxCost = stats.topKnights[0]?.[1] || 1
                return (
                  <div key={name} className="flex items-center gap-3">
                    <span className="w-20 text-sm text-gray-300 truncate">{cfg.emoji} {name}</span>
                    <div className="flex-1">
                      <ProgressBar percent={(cost / maxCost) * 100} fillClass="bg-roundtable-gold/40" heightClass="h-4" />
                    </div>
                    <span className="text-sm text-roundtable-gold w-16 text-right">{formatCost(cost)}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Chain Status */}
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">⛓️ Chains</h2>
            {chainsNote && (
              <span className="text-xs text-yellow-400" data-testid="chains-truncated">{chainsNote}</span>
            )}
            <Link to="/chains" className="text-xs text-roundtable-gold hover:underline flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {chains.length === 0 ? (
            <EmptyState title="No chains configured" />
          ) : (
            <div className="space-y-2">
              {chains.map(chain => (
                <div key={chain.name} className="flex items-center justify-between py-2 border-b border-roundtable-steel/30 last:border-0">
                  <span className="text-sm text-gray-300">{chain.name}</span>
                  <div className="flex items-center gap-2">
                    {chain.schedule && !chain.suspend && chain.nextScheduledAt && (
                      <span className="text-xs text-gray-500">next {until(chain.nextScheduledAt)}</span>
                    )}
                    <span className="text-xs text-gray-500">{(chain.steps || []).length} steps</span>
                    <PhaseBadge phase={chain.phase || 'Pending'} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">📡 Recent Activity</h2>
            <Link to="/flow" className="text-xs text-roundtable-gold hover:underline flex items-center gap-1">
              Live feed <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {(() => { const recent = events.slice(0, 10); const keys = eventListKeys(recent); return recent.map((e, i) => {
              const { knight, domain } = parseEvent(e, fleetDomains)
              const cfg = knight ? getKnightConfig(knight) : null
              return (
                <div key={keys[i]} className="flex items-center gap-2 text-xs py-1">
                  <span>{e.type === 'task' ? '📤' : '📥'}</span>
                  <span>{cfg?.emoji || '🤖'}</span>
                  <span className="text-gray-400 truncate flex-1">{knight || domain || e.type}</span>
                  <span className="text-gray-600">{formatTimestamp(e.timestamp)}</span>
                </div>
              )
            }) })()}
            {events.length === 0 && (
              <EmptyState title="Waiting for activity..." />
            )}
          </div>
        </div>
      </div>

      {/* Cost Details — collapsible */}
      <div className="mt-6 bg-roundtable-slate border border-roundtable-steel rounded-xl overflow-hidden">
        <button
          onClick={() => setCostExpanded(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 hover:bg-roundtable-steel/20 transition-colors"
        >
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-roundtable-gold" />
            Cost Details
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400">
              {filteredCostEntries.length} tasks · {timeRange === 'day' ? 'Last 24h' : timeRange === 'week' ? 'Last 7 days' : 'Last 30 days'}
            </span>
            {costExpanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
          </div>
        </button>

        {costExpanded && (
          <div className="px-5 pb-5">
            {/* Time range + summary */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-4">
                <span className="text-2xl font-bold text-roundtable-gold">{formatCost(costPanelData.totalCost)}</span>
                <div className="flex gap-1.5">
                  {(['day', 'week', 'month'] as const).map(range => (
                    <button
                      key={range}
                      onClick={() => setTimeRange(range)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                        timeRange === range
                          ? 'bg-roundtable-gold/20 text-roundtable-gold border border-roundtable-gold/30'
                          : 'bg-roundtable-steel/50 text-gray-400 hover:text-gray-300'
                      }`}
                    >
                      {range === 'day' ? 'Today' : range === 'week' ? 'Week' : 'Month'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-4 text-sm text-gray-400">
                <span><span className="text-white font-medium">{filteredCostEntries.length}</span> tasks</span>
                <span><span className="text-white font-medium">{costPanelData.costByKnight.length}</span> active knights</span>
                <span>avg <span className="text-roundtable-gold font-medium">{filteredCostEntries.length > 0 ? formatCost(costPanelData.totalCost / filteredCostEntries.length) : '$0.00'}</span>/task</span>
              </div>
              <div className="flex flex-col items-end gap-1">
                <button
                  type="button"
                  onClick={downloadCostCsv}
                  aria-label="Download CSV"
                  className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-roundtable-steel/50 text-gray-300 hover:text-white transition-colors"
                >
                  <Download className="w-3.5 h-3.5" /> Download CSV
                </button>
                <span className="text-xs text-gray-500">Covers recent results only</span>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
              {/* Cost by Knight */}
              <div>
                <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-roundtable-gold" /> Cost by Knight
                </h3>
                {costPanelData.costByKnight.length === 0 ? (
                  <EmptyState title="No cost data available" />
                ) : (
                  <div className="space-y-3">
                    {costPanelData.costByKnight.map(({ knight, cost, tasks, failures }) => {
                      const cfg = getKnightConfig(knight)
                      const barWidth = (cost / (costPanelData.costByKnight[0]?.cost || 1)) * 100
                      return (
                        <div key={knight} className="space-y-1">
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-2">
                              <span className={cfg.color}>{cfg.emoji}</span>
                              <span className="text-gray-300 capitalize">{knight}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className="text-gray-500 text-xs">{tasks} tasks</span>
                              {failures > 0 && <span className="text-red-400 text-xs">{failures} failed</span>}
                              <span className="text-roundtable-gold font-medium">{formatCost(cost)}</span>
                            </div>
                          </div>
                          <ProgressBar percent={barWidth} fillClass="bg-roundtable-gold/40" heightClass="h-2" />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Daily trend */}
              <div>
                <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-blue-400" /> Daily Cost Trend
                </h3>
                {costPanelData.dailyCosts.length === 0 ? (
                  <EmptyState title="No trend data available" />
                ) : (
                  <div className="space-y-2">
                    {costPanelData.dailyCosts.map(({ day, date, cost }) => {
                      const maxCost = Math.max(...costPanelData.dailyCosts.map(d => d.cost), 1)
                      return (
                        <div key={day} className="space-y-1">
                          <div className="flex items-center justify-between text-sm">
                            <span className="text-gray-400">{date}</span>
                            <span className="text-roundtable-gold font-medium">{formatCost(cost)}</span>
                          </div>
                          <ProgressBar percent={(cost / maxCost) * 100} fillClass="bg-blue-400/40" heightClass="h-2" />
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Cost by chain */}
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <Link2 className="w-4 h-4 text-roundtable-gold" /> Cost by Chain
                {chainsNote && (
                  <span className="text-xs text-yellow-400 font-normal" data-testid="cost-chains-truncated">{chainsNote}</span>
                )}
              </h3>
              {chainCostRows.length === 0 ? (
                <EmptyState title="No chain runs in this range" />
              ) : (
                <div className="overflow-x-auto">
                  <table aria-label="Cost by chain" className="w-full">
                    <thead>
                      <tr className="border-b border-roundtable-steel">
                        <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Chain</th>
                        <th scope="col" className="text-right text-gray-400 text-xs font-medium pb-2">Runs</th>
                        <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Latest run</th>
                        <th scope="col" className="text-right text-gray-400 text-xs font-medium pb-2">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chainCostRows.map(row => (
                        <tr key={row.key} className="border-b border-roundtable-steel/30 last:border-0">
                          <td className="py-2">
                            <Link to={`/chains?chain=${encodeURIComponent(row.key)}`} className="text-gray-300 text-sm hover:underline">{row.key}</Link>
                          </td>
                          <td className="py-2 text-right text-gray-400 text-xs">{row.runs}</td>
                          <td className="py-2">
                            <span className="text-gray-500 text-xs">{row.latest ? formatTimestamp(row.latest) : '—'}</span>
                          </td>
                          <td className="py-2 text-right text-roundtable-gold font-medium text-sm">
                            <CostTag
                              costUSD={row.costUSD === null ? null : String(row.costUSD)}
                              notionalUSD={String(row.notionalUSD)}
                              className="justify-end"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Most expensive tasks */}
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-green-400" /> Most Expensive Tasks
              </h3>
              {costPanelData.topTasks.length === 0 ? (
                <EmptyState title="No task data available" />
              ) : (
                <div className="overflow-x-auto">
                  <table aria-label="Most expensive tasks" className="w-full">
                    <thead>
                      <tr className="border-b border-roundtable-steel">
                        <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Knight</th>
                        <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Task ID</th>
                        <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Time</th>
                        <th scope="col" className="text-right text-gray-400 text-xs font-medium pb-2">Cost</th>
                        <th scope="col" className="text-center text-gray-400 text-xs font-medium pb-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => { const taskKeys = uniqueKeys(costPanelData.topTasks.map(t => `${t.knight}:${t.taskId}`)); return costPanelData.topTasks.map((task, i) => {
                        const cfg = getKnightConfig(task.knight)
                        return (
                          <tr key={taskKeys[i]} className="border-b border-roundtable-steel/30 last:border-0">
                            <td className="py-2">
                              <div className="flex items-center gap-2">
                                <span className={cfg.color}>{cfg.emoji}</span>
                                <span className="text-gray-300 text-sm capitalize">{task.knight}</span>
                              </div>
                            </td>
                            <td className="py-2">
                              <span className="text-gray-400 text-xs font-mono truncate max-w-[200px] block">{task.taskId}</span>
                            </td>
                            <td className="py-2">
                              <span className="text-gray-500 text-xs">{formatTimestamp(task.timestamp)}</span>
                            </td>
                            <td className="py-2 text-right">
                              <span className="text-roundtable-gold font-medium text-sm">{formatCost(task.cost)}</span>
                            </td>
                            <td className="py-2 text-center">
                              <span className={`text-xs px-2 py-0.5 rounded-full ${task.success ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                                {task.success ? 'Success' : 'Failed'}
                              </span>
                            </td>
                          </tr>
                        )
                      }) })()}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
