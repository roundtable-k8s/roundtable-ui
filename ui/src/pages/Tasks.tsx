import { useState, useEffect, useMemo, useRef } from 'react'
import { Scroll, Clock } from 'lucide-react'
import { apiPost } from '../lib/api'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { SubmissionKey } from '../lib/submissionKey'
import { getKnightConfig } from '../lib/knights'
import { useFleet } from '../hooks/useFleet'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTableFilter } from '../hooks/useTableFilter'
import { useTaskPoller } from '../hooks/useTaskPoller'
import { isFinalStatus, type GatewayTask, type PullRequestRef } from '../lib/gatewayTask'
import { taskRows, type TableInfo } from '../lib/tables'
import { useToast } from '../components/Toast'
import { TraceLink } from '../components/TraceLink'
import { PageHeader, EmptyState, ErrorBanner, TableBadge, Badge } from '../components/ui'
import type { Tone } from '../lib/tone'
import { formatTimestampOrDate, formatSecondsLadder } from '../lib/format'
import { sanitizeText, safeUrl } from '../lib/untrusted'
import { CostTag } from '../components/CostTag'
import { tokensText } from '../lib/cost'

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

const STORAGE_KEY = 'roundtable.dispatch.recent.v1'
const MAX_STORED = 20

/** Restore the recently dispatched tasks (no outputs) from sessionStorage. */
function loadStored(): DispatchedTask[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((r): r is DispatchedTask => !!r && typeof r.taskId === 'string' && typeof r.knight === 'string')
      .slice(0, MAX_STORED)
      .map((r) => ({
        taskId: r.taskId,
        knight: r.knight,
        table: typeof r.table === 'string' ? r.table : '',
        task: typeof r.task === 'string' ? r.task : '',
        status: typeof r.status === 'string' ? r.status : 'pending',
        timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
      }))
  } catch {
    return []
  }
}

function saveStored(results: DispatchedTask[]) {
  try {
    const slim = results.slice(0, MAX_STORED).map((r) => ({
      taskId: r.taskId, knight: r.knight, table: r.table, task: r.task, status: r.status, timestamp: r.timestamp,
    }))
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(slim))
  } catch {
    // storage unavailable or full: the list just won't survive navigation
  }
}

function statusTone(status: string): Tone {
  if (status === 'succeeded') return 'green'
  if (status === 'failed') return 'red'
  return 'blue'
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
  if (r.durationMs) parts.push(<span key="dur">{formatSecondsLadder(r.durationMs / 1000)}</span>)
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
  const [results, setResults] = useState<DispatchedTask[]>(loadStored)
  // Every RoundTable the API covers (#239), for the history filter
  const tablesResp = usePolledFetch<{ tables?: TableInfo[] } | null>('/api/tables', 0, null).data
  const tables = useMemo(() => tablesResp?.tables ?? [], [tablesResp])
  // Shared table filter (?table=); '' = all tables
  const { table: tableFilter } = useTableFilter()
  const { events } = useWebSocket()

  // The chosen knight, or the first one when the fleet no longer lists it
  const effective = knights.some((k) => k.name === knight) ? knight : knights[0]?.name ?? ''
  useEffect(() => {
    if (effective !== knight) setKnight(effective)
  }, [effective, knight])

  useEffect(() => { saveStored(results) }, [results])

  const selected = knights.find((k) => k.name === effective)
  const config = getKnightConfig(effective)
  const domain = selected?.domain ?? ''
  const rows = useMemo(() => taskRows(events, tables, tableFilter), [events, tables, tableFilter])

  // Poll dispatched tasks through the gateway until they finish; five failed polls mark a row unavailable
  useTaskPoller<DispatchedTask, GatewayTask>({
    items: results,
    idOf: (r) => r.taskId,
    isDone: (r) => isFinalStatus(r.status) || !!r.unavailable,
    fetchUrl: (r) => `/api/tasks/dispatch/${encodeURIComponent(r.taskId)}`,
    onUpdate: (id, t) => setResults((prev) => prev.map((r) => (r.taskId === id ? mergeTask(r, t) : r))),
    onGiveUp: (id) => setResults((prev) => prev.map((r) => (r.taskId === id ? { ...r, unavailable: true } : r))),
  })

  const dispatch = async () => {
    if (!task.trim() || !selected || dispatching) return
    setDispatching(true)

    try {
      const body = {
        knight: effective,
        task,
        ...(selected.namespace ? { namespace: selected.namespace } : {}),
      }
      const key = submission.current.next(JSON.stringify(body))
      const data = await apiPost<GatewayTask>('/api/tasks/dispatch', body, { headers: { 'Idempotency-Key': key } })
      submission.current.settle()
      setResults((prev) => [mergeTask({
        taskId: data.taskId,
        knight: effective,
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
        <div className="flex flex-col sm:flex-row gap-4 mb-4">
          <div className="w-full sm:w-48">
            <label htmlFor="task-knight" className="text-sm text-gray-400 mb-2 block">Knight</label>
            <select id="task-knight"
              value={effective}
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
          <div className="flex-1 min-w-0">
            <label htmlFor="task-quest" className="text-sm text-gray-400 mb-2 block">Quest</label>
            <div className="flex gap-2">
              <input
                id="task-quest"
                type="text"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && dispatch()}
                placeholder={effective ? `Send a quest to ${config.emoji} ${effective} (${domain})...` : 'Waiting for fleet…'}
                className="flex-1 min-w-0 bg-roundtable-navy border border-roundtable-steel rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:border-roundtable-gold/50 focus:outline-none"
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
          Dispatching to <span className="text-roundtable-gold font-mono">{effective || '—'}</span>
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
                  <Badge tone={statusTone(r.status)} strength="strong" testId="dispatch-status">
                    {r.unavailable ? 'status unavailable' : r.status}
                  </Badge>
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
