import { useState, useMemo, useCallback } from 'react'
import { GitGraph, Wifi, WifiOff, Filter, Activity } from 'lucide-react'
import { useWebSocket, type NatsEvent } from '../hooks/useWebSocket'
import { useFleet } from '../hooks/useFleet'
import type { Knight } from '../hooks/useFleet'
import { getKnightConfig, knightNameForDomain } from '../lib/knights'
import { parseEvent, parseEventData, eventListKeys, displayText, resultFailureReason } from '../lib/events'
import { FleetGraph } from '../components/FleetGraph'
import { KnightDetailDrawer } from '../components/KnightDetailDrawer'
import { TaskActivityPanel } from '../components/TaskActivityPanel'
import { PageHeader, StatCard, EmptyState, ErrorBanner } from '../components/ui'
import { formatCost, formatTimestamp } from '../lib/format'

export function LivePage() {
  const { events, connected, error: wsError, historyError } = useWebSocket()
  const { knights: fleetKnights, error: fleetError } = useFleet()
  const [filterKnight, setFilterKnight] = useState<string>('')
  const [filterType, setFilterType] = useState<string>('')
  const [filterDomain, setFilterDomain] = useState<string>('')
  // Selection is a key plus a fallback for knights absent from the fleet; the
  // fleet entry is looked up each render so the drawer stays live.
  // namespace is undefined for a knight clicked before it was in the fleet:
  // match by name alone so it picks up the real entry once the poll lands.
  const [selected, setSelected] = useState<{ name: string; namespace?: string; fallback: Knight } | null>(null)
  const selectedKnight = selected
    ? fleetKnights.find(k => k.name === selected.name && (selected.namespace === undefined || k.namespace === selected.namespace)) ?? selected.fallback
    : null
  const [activityTask, setActivityTask] = useState<{ taskId: string; knight?: string } | null>(null)

  const handleKnightClick = useCallback((knightName: string) => {
    const fleet = fleetKnights.find(k => k.name === knightName)
    if (fleet) {
      setSelected({ name: fleet.name, namespace: fleet.namespace, fallback: fleet })
    } else {
      // Build a minimal Knight object for knights not in fleet response
      const cfg = getKnightConfig(knightName)
      setSelected({ name: knightName, fallback: {
        name: knightName,
        domain: cfg.domain,
        status: 'offline',
        ready: false,
        restarts: 0,
        age: '—',
        image: '',
        skills: 0,
        nixTools: 0,
        labels: {},
      } })
    }
  }, [fleetKnights])

  // Filter options: the real fleet plus any knight/domain seen in events
  const { knightNames, domains } = useMemo(() => {
    const names = new Set(fleetKnights.map(k => k.name))
    const doms = new Set(fleetKnights.map(k => k.domain).filter(Boolean))
    for (const event of events) {
      const parsed = parseEvent(event)
      if (parsed.knight) names.add(parsed.knight)
      if (parsed.domain) doms.add(parsed.domain)
    }
    return { knightNames: [...names].sort(), domains: [...doms].sort() }
  }, [fleetKnights, events])

  // Knight online statuses from fleet API
  const knightStatuses = useMemo(() => {
    const m: Record<string, string> = {}
    for (const k of fleetKnights) m[k.name] = k.status
    return m
  }, [fleetKnights])

  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      if (filterType && event.type !== filterType) return false
      const parsed = parseEvent(event)
      if (filterDomain) {
        // Results carry no domain — fall back to the knight's configured domain
        const domain = parsed.domain || (parsed.knight ? getKnightConfig(parsed.knight).domain : '')
        if (domain !== filterDomain) return false
      }
      if (filterKnight && parsed.knight !== filterKnight) return false
      return true
    })
  }, [events, filterKnight, filterType, filterDomain])

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const recentEvents = filteredEvents.slice(0, 50)
  const recentKeys = eventListKeys(recentEvents)

  return (
    <div>
      {fleetError && (
        <div className="mb-4">
          <ErrorBanner>Failed to load fleet: {fleetError}</ErrorBanner>
        </div>
      )}
      {/* Header */}
      <PageHeader icon={GitGraph} title="Message Flow">
        {connected ? (
          <><Wifi className="w-4 h-4 text-green-400" /><span className="text-green-400 text-sm">Connected</span></>
        ) : (
          <><WifiOff className="w-4 h-4 text-red-400" /><span className="text-red-400 text-sm">Disconnected</span>{wsError && <span className="text-red-400/80 text-xs">({wsError})</span>}</>
        )}
        <span className="text-gray-500 text-sm">({filteredEvents.length} events)</span>
      </PageHeader>

      {/* Compact filter toolbar */}
      <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-3 mb-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Filter className="w-4 h-4 text-gray-400" />
          <select aria-label="Filter by knight" value={filterKnight} onChange={e => setFilterKnight(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-1 text-sm text-white">
            <option value="">All Knights</option>
            {knightNames.map(k => <option key={k} value={k}>{getKnightConfig(k).emoji} {k}</option>)}
          </select>
          <select aria-label="Filter by type" value={filterType} onChange={e => setFilterType(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-1 text-sm text-white">
            <option value="">All Types</option>
            <option value="task">📤 Tasks</option>
            <option value="result">📥 Results</option>
          </select>
          <select aria-label="Filter by domain" value={filterDomain} onChange={e => setFilterDomain(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-1 text-sm text-white">
            <option value="">All Domains</option>
            {domains.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          {(filterKnight || filterType || filterDomain) && (
            <button onClick={() => { setFilterKnight(''); setFilterType(''); setFilterDomain('') }}
              className="text-xs text-gray-400 hover:text-white">Clear</button>
          )}
        </div>
      </div>

      {/* Round Table Graph */}
      {/* Fleet network graph — React Flow powered */}
      <FleetGraph knights={fleetKnights} events={filteredEvents} connected={connected} knightStatuses={knightStatuses} onKnightClick={handleKnightClick} />

      {/* Inter-knight comms summary (#51) */}
      {(() => {
        const comms: Record<string, number> = {}
        for (const event of filteredEvents.slice(0, 100)) {
          const parsed = parseEvent(event)
          const from = knightNameForDomain((parsed.data.from as string) || '')
          const to = parsed.knight
          if (from && to && from !== to) {
            const key = `${from} → ${to}`
            comms[key] = (comms[key] || 0) + 1
          }
        }
        const entries = Object.entries(comms).sort((a, b) => b[1] - a[1])
        if (entries.length === 0) return null

        return (
          <div className="mt-4 bg-roundtable-slate border border-roundtable-steel rounded-xl p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-2">🔗 Knight-to-Knight Communications</h3>
            <div className="flex flex-wrap gap-2">
              {entries.map(([route, count]) => {
                const [from, to] = route.split(' → ')
                const fromCfg = getKnightConfig(from)
                const toCfg = getKnightConfig(to)
                return (
                  <span key={route} className="text-xs bg-roundtable-navy border border-roundtable-steel px-2.5 py-1 rounded-full">
                    {fromCfg.emoji} <span className="text-gray-400">→</span> {toCfg.emoji} <span className="text-gray-500">×{count}</span>
                  </span>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Event summary stats */}
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {(() => {
          const tasks = filteredEvents.filter(e => e.type === 'task').length
          const results = filteredEvents.filter(e => e.type === 'result').length
          const failures = filteredEvents.filter(e => {
            if (e.type !== 'result') return false
            const d = parseEventData(e.data)
            return resultFailureReason(d) !== null
          }).length
          const totalCost = filteredEvents.reduce((sum, e) => {
            if (e.type !== 'result') return sum
            const d = parseEventData(e.data)
            return sum + (typeof d.cost === 'number' ? d.cost : 0)
          }, 0)
          return (<>
            <StatCard label="Tasks" value={tasks} color="text-blue-400" />
            <StatCard label="Results" value={results} color="text-green-400" />
            <StatCard label="Failures" value={failures} color="text-red-400" />
            <StatCard label="Cost" value={formatCost(totalCost)} color="text-roundtable-gold" />
          </>)
        })()}
      </div>

      {/* Recent messages log */}
      <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Messages</h3>
        {historyError && (
          <div className="mb-3">
            <ErrorBanner>Could not load message history: {historyError}</ErrorBanner>
          </div>
        )}
        {recentEvents.length === 0 ? (
          <EmptyState title={historyError ? 'No messages loaded' : 'Waiting for messages…'} />
        ) : (
          <div className="space-y-2">
            {recentEvents.map((event, i) => (
              <EventCard key={recentKeys[i]} event={event} index={i}
                expanded={expandedId === recentKeys[i]} onToggle={() => setExpandedId(expandedId === recentKeys[i] ? null : recentKeys[i])}
                onOpenActivity={(taskId, knight) => setActivityTask({ taskId, knight })} />
            ))}
          </div>
        )}
      </div>

      {/* Knight detail drawer */}
      <KnightDetailDrawer knight={selectedKnight} onClose={() => setSelected(null)} />

      {/* Task activity drawer (#214) */}
      {activityTask && (
        <TaskActivityPanel
          taskId={activityTask.taskId}
          hint={activityTask.knight ? { knight: activityTask.knight } : undefined}
          onClose={() => setActivityTask(null)}
        />
      )}
    </div>
  )
}

function EventCard({ event, expanded, onToggle, onOpenActivity }: {
  event: NatsEvent; index: number; expanded: boolean; onToggle: () => void
  onOpenActivity?: (taskId: string, knight?: string) => void
}) {
  const { knight, data, taskId } = parseEvent(event)
  const cfg = knight ? getKnightConfig(knight) : null
  const isTask = event.type === 'task'
  const taskText = displayText(data.task || data.result || data.summary)
  const success = data.success as boolean | undefined
  const cost = typeof data.cost === 'number' ? data.cost : undefined
  // pi-knight publishes duration_ms and tool_calls
  const durationMs = typeof data.duration_ms === 'number' ? data.duration_ms : undefined
  const toolCalls = typeof data.tool_calls === 'number' ? data.tool_calls : undefined

  return (
    <div
      className={`rounded-lg border transition-colors cursor-pointer ${
        isTask ? 'bg-blue-500/5 border-blue-500/10' : 'bg-green-500/5 border-green-500/10'
      } ${expanded ? 'ring-1 ring-roundtable-gold/30' : ''}`}
      onClick={onToggle}
    >
      <div className="flex items-center gap-2 text-xs px-3 py-2">
        <span className={isTask ? 'text-blue-400' : 'text-green-400'}>{isTask ? '📤' : '📥'}</span>
        <span className={`font-medium ${isTask ? 'text-blue-400' : 'text-green-400'}`}>
          {isTask ? 'TASK' : 'RESULT'}
        </span>
        {cfg && <span className={cfg.color}>{cfg.emoji} {knight}</span>}
        {!isTask && success !== undefined && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
            success ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
          }`}>
            {success ? 'OK' : 'FAIL'}
          </span>
        )}
        {!isTask && cost !== undefined && (
          <span className="text-gray-500">{formatCost(cost)}</span>
        )}
        {!isTask && durationMs !== undefined && (
          <span className="text-gray-500">{(durationMs / 1000).toFixed(1)}s</span>
        )}
        {!isTask && toolCalls !== undefined && (
          <span className="text-gray-500">🔧{toolCalls}</span>
        )}
        <span className="text-gray-600 ml-auto flex-shrink-0">
          {formatTimestamp(event.timestamp)}
        </span>
        {taskId && onOpenActivity && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onOpenActivity(taskId, knight ?? undefined) }}
            className="flex items-center gap-1 text-gray-400 hover:text-roundtable-gold flex-shrink-0"
            aria-label={`Task activity ${taskId}`}
            title="Task activity"
          >
            <Activity className="w-3.5 h-3.5" aria-hidden />
          </button>
        )}
      </div>
      <div className="px-3 pb-2">
        <p className={`text-xs text-gray-400 ${expanded ? '' : 'line-clamp-2'}`}>{taskText}</p>
      </div>
      {expanded && (
        <div className="px-3 pb-3 border-t border-roundtable-steel/30 mt-1 pt-2">
          <pre className="text-[10px] text-gray-500 overflow-x-auto max-h-48 whitespace-pre-wrap">
            {JSON.stringify(data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
