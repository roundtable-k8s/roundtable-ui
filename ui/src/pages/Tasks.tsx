import { useState, useEffect, useMemo, useRef } from 'react'
import { Scroll, Clock } from 'lucide-react'
import { apiGet, apiPost } from '../lib/api'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { SubmissionKey } from '../lib/submissionKey'
import { getKnightConfig } from '../lib/knights'
import { useFleet } from '../hooks/useFleet'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTableFilter } from '../hooks/useTableFilter'
import { useVisibleInterval } from '../hooks/useVisibleInterval'
import { taskRows, type TableInfo } from '../lib/tables'
import { useToast } from '../components/Toast'
import { TraceLink } from '../components/TraceLink'
import { PageHeader, EmptyState, ErrorBanner, TableBadge } from '../components/ui'
import { formatTimestampOrDate } from '../lib/format'
import { sanitizeText, safeUrl } from '../lib/untrusted'
import { CostTag } from '../components/CostTag'
import { tokensText } from '../lib/cost'

const POLL_MS = 2000

/** Task record returned by the gateway (POST /v1/knights/{name}/invoke, GET /v1/tasks/{id}). */
interface GatewayTask {
  taskId: string
  runId?: string
  roundTable?: string
  status?: string
  output?: string
  error?: string
  traceId?: string
  usageLimited?: boolean
  model?: string
  requestedModel?: string
  cost?: number
  billing?: string
  durationMs?: number
  tokens?: { input?: number; output?: number }
  turns?: number
  toolCalls?: number
  prs?: PullRequestRef[]
  verdict?: string
}

/** A pull request the task opened or touched (gateway PRRef). */
interface PullRequestRef {
  repo?: string
  number?: number
  url?: string
  action?: string
}

type UsageFields = Pick<GatewayTask, 'usageLimited' | 'model' | 'requestedModel' | 'cost' | 'billing' | 'durationMs' | 'tokens' | 'turns' | 'toolCalls' | 'prs' | 'verdict'>

interface DispatchedTask extends UsageFields {
  taskId: string
  knight: string
  table: string
  task: string
  status: string
  output?: string
  error?: string
  traceId?: string
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
    traceId: t.traceId || r.traceId,
    usageLimited: t.usageLimited ?? r.usageLimited,
    model: t.model ?? r.model,
    requestedModel: t.requestedModel ?? r.requestedModel,
    cost: t.cost ?? r.cost,
    billing: t.billing ?? r.billing,
    durationMs: t.durationMs ?? r.durationMs,
    tokens: t.tokens ?? r.tokens,
    turns: t.turns ?? r.turns,
    toolCalls: t.toolCalls ?? r.toolCalls,
    prs: t.prs ?? r.prs,
    verdict: t.verdict ?? r.verdict,
  }
}

function durationText(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function prLabel(pr: PullRequestRef): string {
  const ref = pr.number ? (pr.repo ? `${pr.repo}#${pr.number}` : `#${pr.number}`) : pr.repo || 'pull request'
  return pr.action ? `${ref} (${pr.action})` : ref
}

/** Model, usage, turns, tool calls and duration; each part is omitted when absent. */
function UsageLine({ r }: { r: DispatchedTask }) {
  const parts: React.ReactNode[] = []
  if (r.model || r.requestedModel) {
    const m = sanitizeText(r.model || r.requestedModel)
    const req = r.model && r.requestedModel && r.model !== r.requestedModel ? ` (requested ${sanitizeText(r.requestedModel)})` : ''
    parts.push(<span key="model" className="font-mono">{m}{req}</span>)
  }
  if (r.cost !== undefined && r.cost !== null) {
    parts.push(<CostTag key="cost" costUSD={String(r.cost)} notional={r.billing === 'subscription'} />)
  }
  if (r.tokens) parts.push(<span key="tokens">{tokensText({ input: r.tokens.input ?? 0, output: r.tokens.output ?? 0 })}</span>)
  if (r.turns) parts.push(<span key="turns">{r.turns} {r.turns === 1 ? 'turn' : 'turns'}</span>)
  if (r.toolCalls !== undefined && r.toolCalls !== null) parts.push(<span key="tools">{r.toolCalls} tool {r.toolCalls === 1 ? 'call' : 'calls'}</span>)
  if (r.durationMs) parts.push(<span key="dur">{durationText(r.durationMs)}</span>)
  if (parts.length === 0) return null
  return (
    <div data-testid="dispatch-usage" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
      {parts}
    </div>
  )
}

function PullRequests({ prs }: { prs?: PullRequestRef[] }) {
  if (!prs || prs.length === 0) return null
  return (
    <ul data-testid="dispatch-prs" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {prs.map((pr, i) => {
        const href = safeUrl(pr.url)
        const label = sanitizeText(prLabel(pr))
        return (
          <li key={pr.url || i}>
            {/^https?:/i.test(href) ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="text-roundtable-gold hover:underline">{label}</a>
            ) : (
              <span className="text-gray-300">{label}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function TasksPage() {
  const { knights, error: fleetError } = useFleet(60000)
  const { addToast } = useToast()
  const [knight, setKnight] = useState('')
  const [task, setTask] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const submission = useRef(new SubmissionKey())
  const [results, setResults] = useState<DispatchedTask[]>([])
  // Every RoundTable the API covers (#239), for the history filter
  const tablesResp = usePolledFetch<{ tables?: TableInfo[] } | null>('/api/tables', 0, null).data
  const tables = useMemo(() => tablesResp?.tables ?? [], [tablesResp])
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
    if (!task.trim() || !selected || dispatching) return
    setDispatching(true)

    try {
      const body = {
        knight,
        task,
        ...(selected.namespace ? { namespace: selected.namespace } : {}),
      }
      const key = submission.current.next(JSON.stringify(body))
      const data = await apiPost<GatewayTask>('/api/tasks/dispatch', body, { headers: { 'Idempotency-Key': key } })
      submission.current.settle()
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
      submission.current.settle(e)
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
              <TraceLink traceId={r.traceId} />
              {r.output && (
                <pre data-testid="dispatch-output" className="mt-2 text-sm text-gray-200 bg-roundtable-navy rounded p-3 whitespace-pre-wrap break-words max-h-64 overflow-auto">{sanitizeText(r.output)}</pre>
              )}
              <UsageLine r={r} />
              <PullRequests prs={r.prs} />
              {r.verdict && (
                <span data-testid="dispatch-verdict" className="inline-block mt-2 text-xs px-2 py-0.5 rounded bg-roundtable-navy border border-roundtable-steel text-gray-200">
                  Verdict: {sanitizeText(r.verdict)}
                </span>
              )}
              {r.usageLimited ? (
                <p className="mt-2 text-sm text-amber-400">Usage limit reached: retry later</p>
              ) : (
                r.error && <p className="mt-2 text-sm text-red-400">{sanitizeText(r.error)}</p>
              )}
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
