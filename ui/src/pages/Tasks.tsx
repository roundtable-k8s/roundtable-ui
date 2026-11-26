import { useState, useEffect, useMemo, useRef } from 'react'
import { useVisibleInterval } from '../hooks/useVisibleInterval'
import { Scroll, Clock } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { getKnightConfig } from '../lib/knights'
import { useFleet } from '../hooks/useFleet'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTableFilter } from '../hooks/useTableFilter'
import { taskRows, type TableInfo } from '../lib/tables'
import { useToast } from '../components/Toast'
import { PageHeader, EmptyState, ErrorBanner, TableBadge } from '../components/ui'
import { formatTimestampOrDate } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'

const POLL_MS = 2000

/** Task record returned by the gateway (POST /v1/knights/{name}/invoke, GET /v1/tasks/{id}). */
interface GatewayTask {
  taskId: string
  runId?: string
  roundTable?: string
  status?: string
  output?: string
  error?: string
}

interface DispatchedTask {
  taskId: string
  knight: string
  table: string
  task: string
  status: string
  output?: string
  error?: string
  timestamp: string
  /** Set after repeated failed status polls; the task is no longer polled. */
  unavailable?: boolean
}

const MAX_POLL_FAILURES = 5

const isFinal = (status: string) => status === 'succeeded' || status === 'failed'

function statusClass(status: string) {
  if (status === 'succeeded') return 'bg-green-500/20 text-green-400'
  if (status === 'failed') return 'bg-red-500/20 text-red-400'
  return 'bg-blue-500/20 text-blue-400'
}

function mergeTask(r: DispatchedTask, t: GatewayTask): DispatchedTask {
  return {
    ...r,
    taskId: t.taskId || r.taskId,
    table: t.roundTable ?? r.table,
    status: t.status ?? r.status,
    output: t.output ?? r.output,
    error: t.error ?? r.error,
  }
}

export function TasksPage() {
  const { knights, error: fleetError } = useFleet(60000)
  const { addToast } = useToast()
  const [knight, setKnight] = useState('')
  const [task, setTask] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const [results, setResults] = useState<DispatchedTask[]>([])
  // Every RoundTable the API covers (#239), for the history filter
  const [tables, setTables] = useState<TableInfo[]>([])
  // Shared table filter (?table=); '' = all tables
  const { table: tableFilter } = useTableFilter()
  const { events } = useWebSocket()

  // Default to the first knight once the fleet loads
  useEffect(() => {
    if (!knight && knights.length > 0) setKnight(knights[0].name)
  }, [knight, knights])

  const selected = knights.find((k) => k.name === knight)
  const config = getKnightConfig(knight)
  const domain = selected?.domain ?? ''
  const rows = useMemo(() => taskRows(events, tables, tableFilter), [events, tables, tableFilter])

  useEffect(() => {
    apiGet<{ tables?: TableInfo[] }>('/api/tasks')
      .then((data) => setTables(data.tables ?? []))
      .catch(() => {})
  }, [])

  // Consecutive failed polls per task id
  const failures = useRef(new Map<string, number>())
  // Poll dispatched tasks through the gateway until they finish
  const pendingIds = results.filter((r) => !isFinal(r.status) && !r.unavailable).map((r) => r.taskId).join(',')
  useVisibleInterval(
    (signal) =>
      Promise.all(pendingIds.split(',').map((id) =>
        apiGet<GatewayTask>(`/api/tasks/dispatch/${encodeURIComponent(id)}`, { signal })
          .then((t) => {
            failures.current.delete(id)
            setResults((prev) => prev.map((r) => (r.taskId === id ? mergeTask(r, t) : r)))
          })
          .catch(() => {
            if (signal.aborted) return
            const n = (failures.current.get(id) ?? 0) + 1
            failures.current.set(id, n)
            if (n >= MAX_POLL_FAILURES) {
              setResults((prev) => prev.map((r) => (r.taskId === id ? { ...r, unavailable: true } : r)))
            }
          }),
      )),
    POLL_MS,
    !!pendingIds,
    { key: pendingIds },
  )

  const dispatch = async () => {
    if (!task.trim() || !selected) return
    setDispatching(true)

    try {
      const data = await apiPost<GatewayTask>('/api/tasks/dispatch', {
        knight,
        task,
        ...(selected.namespace ? { namespace: selected.namespace } : {}),
      })
      setResults((prev) => [mergeTask({
        taskId: data.taskId,
        knight,
        table: '',
        task,
        status: 'pending',
        timestamp: new Date().toISOString(),
      }, data), ...prev])
      setTask('')
    } catch (e) {
      addToast(`Dispatch failed: ${e instanceof Error ? e.message : 'unknown error'}`, 'error')
    } finally {
      setDispatching(false)
    }
  }

  return (
    <div>
      <PageHeader icon={Scroll} title="Dispatch" />

      {fleetError && knights.length === 0 && (
        <div className="mb-6">
          <ErrorBanner>Cannot load the knight roster: {fleetError}</ErrorBanner>
        </div>
      )}

      {/* Dispatch form */}
      <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-6 mb-8">
        <div className="flex gap-4 mb-4">
          <div className="w-48">
            <label htmlFor="task-knight" className="text-sm text-gray-400 mb-2 block">Knight</label>
            <select id="task-knight"
              value={knight}
              onChange={(e) => setKnight(e.target.value)}
              className="w-full bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white"
            >
              {knights.length === 0 && <option value="">Loading fleet…</option>}
              {knights.map((k) => (
                <option key={k.name} value={k.name}>
                  {getKnightConfig(k.name).emoji} {k.name} ({k.domain})
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label htmlFor="task-quest" className="text-sm text-gray-400 mb-2 block">Quest</label>
            <div className="flex gap-2">
              <input
                id="task-quest"
                type="text"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && dispatch()}
                placeholder={knight ? `Send a quest to ${config.emoji} ${knight} (${domain})...` : 'Waiting for fleet…'}
                className="flex-1 bg-roundtable-navy border border-roundtable-steel rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:border-roundtable-gold/50 focus:outline-none"
              />
              <button
                onClick={dispatch}
                disabled={dispatching || !task.trim() || !selected}
                className="px-6 py-2 bg-roundtable-gold/20 hover:bg-roundtable-gold/30 border border-roundtable-gold/30 rounded-lg text-roundtable-gold font-medium transition-colors disabled:opacity-50"
              >
                {dispatching ? '...' : 'Dispatch'}
              </button>
            </div>
          </div>
        </div>
        <p className="text-xs text-gray-500">
          Dispatching to <span className="text-roundtable-gold font-mono">{knight || '—'}</span>
          {domain && <> (domain <span className="font-mono">{domain}</span>)</>} through the invoke gateway, which routes to the knight's own table.
        </p>
      </div>

      {/* Recent dispatches */}
      <h2 className="text-xl font-bold text-white mb-4">Recent Dispatches</h2>
      <div className="space-y-3 mb-10">
        {results.length === 0 && (
          <EmptyState title="No quests dispatched yet. Send one above!" />
        )}
        {results.map((r) => {
          const kc = getKnightConfig(r.knight)
          return (
            <div
              key={r.taskId}
              className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-4"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span>{kc.emoji}</span>
                  <span className="font-medium text-white capitalize">{r.knight}</span>
                  {r.table && <TableBadge table={r.table} />}
                  <span data-testid="dispatch-status" className={`text-xs px-2 py-0.5 rounded ${statusClass(r.status)}`}>
                    {r.unavailable ? 'status unavailable' : r.status}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-gray-500 text-xs">
                  <Clock className="w-3 h-3" />
                  {formatTimestampOrDate(r.timestamp)}
                </div>
              </div>
              <p className="text-gray-300 text-sm">{r.task}</p>
              <p className="text-gray-500 text-xs mt-1 font-mono">{r.taskId}</p>
              {r.output && (
                <pre data-testid="dispatch-output" className="mt-2 text-sm text-gray-200 bg-roundtable-navy rounded p-3 whitespace-pre-wrap break-words max-h-64 overflow-auto">{sanitizeText(r.output)}</pre>
              )}
              {r.error && <p className="mt-2 text-sm text-red-400">{sanitizeText(r.error)}</p>}
            </div>
          )
        })}
      </div>

      {/* Task history across every table (#239) */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-white">Task History</h2>
      </div>
      <div className="space-y-2" data-testid="task-history">
        {rows.length === 0 && <EmptyState title="No tasks seen yet." />}
        {rows.map((r) => (
          <div
            key={r.key}
            data-testid="task-row"
            className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={
                  r.type === 'task'
                    ? 'text-xs bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded'
                    : r.success
                      ? 'text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded'
                      : 'text-xs bg-red-500/20 text-red-400 px-2 py-0.5 rounded'
                }>
                  {r.type === 'task' ? 'task' : r.success ? 'done' : 'failed'}
                </span>
                {r.knight && <span className="font-medium text-white capitalize">{r.knight}</span>}
                {!tableFilter && <TableBadge table={r.table} />}
                <span className="text-gray-500 text-xs font-mono truncate">{r.taskId}</span>
              </div>
              <div className="flex items-center gap-1 text-gray-500 text-xs shrink-0">
                <Clock className="w-3 h-3" />
                {formatTimestampOrDate(r.timestamp)}
              </div>
            </div>
            {r.text && <p className="text-gray-300 text-sm mt-1 line-clamp-2">{r.text}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
