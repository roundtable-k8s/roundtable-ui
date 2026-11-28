import { useEffect, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useUrlParams } from '../hooks/useUrlParams'
import { Activity } from 'lucide-react'
import { useTableFilter } from '../hooks/useTableFilter'
import { inTable } from '../lib/tables'
import { useRunning } from '../hooks/useRunning'
import { useNow } from '../hooks/useNow'
import { useWebSocket } from '../hooks/useWebSocket'
import { PageHeader, RefreshButton, StatCard, ErrorBanner, ListState, Badge, DataTable } from '../components/ui'
import type { Tone } from '../lib/tone'
import { TaskActivityPanel } from '../components/TaskActivityPanel'
import { formatCost, formatNumber } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { chainHref } from '../lib/links'
import {
  countByStatus,
  filterRunning,
  formatRunningAge,
  type RunningStatus,
  type RunningTask,
} from '../lib/running'

const STATUS_STYLES: Record<RunningStatus, { row: string; tone: Tone; text: string }> = {
  running: { row: '', tone: 'blue', text: 'text-gray-300' },
  stale: { row: 'bg-yellow-500/10', tone: 'yellow', text: 'text-yellow-400' },
  lost: { row: 'bg-red-500/10', tone: 'red', text: 'text-red-400' },
}

function StatusBadge({ status }: { status: RunningStatus }) {
  return (
    <Badge tone={STATUS_STYLES[status].tone} strength="strong" className="font-medium">{status}</Badge>
  )
}

function ChainCell({ task }: { task: RunningTask }) {
  if (!task.chainName) return <span className="text-gray-600">—</span>
  return (
    <Link
      to={chainHref(task.chainName)}
      onClick={(e) => e.stopPropagation()}
      className="text-roundtable-gold hover:underline"
    >
      {task.chainName}
      {task.stepName && <span className="text-gray-400"> / {task.stepName}</span>}
    </Link>
  )
}

function lastToolLabel(task: RunningTask): string {
  const tool = task.currentTool || task.lastTool?.tool
  return tool ? sanitizeText(tool) : ''
}

/** Registry details shown above the activity timeline while the task is in flight. */
function RunningExtra({ task, now }: { task: RunningTask; now: number }) {
  const rows: Array<[string, ReactNode]> = [
    ['Status', <StatusBadge key="s" status={task.status} />],
    ['Node', task.node || '—'],
    ['Slot', task.slot != null ? `${task.slot}${task.concurrency != null ? ` of ${task.concurrency}` : ''}` : '—'],
    ['Heartbeat age', formatRunningAge(task.lastHeartbeat, now)],
    ['Turns', task.turns ?? '—'],
    ['Tokens', task.inputTokens != null || task.outputTokens != null
      ? `${formatNumber(task.inputTokens ?? 0)} in / ${formatNumber(task.outputTokens ?? 0)} out`
      : '—'],
  ]
  if (task.reason) rows.splice(1, 0, ['Reason', sanitizeText(task.reason)])
  return (
    <dl className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm" aria-label="Running status">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gray-500">{k}</dt>
          <dd className="col-span-2 text-gray-200 tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const RUNNING_DEFAULTS = { knight: '', chain: '', status: '', task: '' }
const RUNNING_ALLOWED = { status: ['running', 'stale', 'lost'] }

export function RunningPage() {
  const rowsHintId = useId()
  const { tasks, loading, error, unavailable, refresh } = useRunning()
  const { connected } = useWebSocket()
  const now = useNow()
  const [{ knight, chain, status: statusValue, task: selectedId }, setParams] = useUrlParams(RUNNING_DEFAULTS, RUNNING_ALLOWED)
  const status = statusValue as RunningStatus | ''
  const setParam = (key: keyof typeof RUNNING_DEFAULTS, value: string) => setParams({ [key]: value })

  const { table } = useTableFilter()
  const all = useMemo(() => [...tasks.values()].filter((t) => inTable(table, t.table)), [tasks, table])
  const counts = useMemo(() => countByStatus(all), [all])
  const knights = useMemo(() => [...new Set(all.map((t) => t.knight))].sort(), [all])
  const chains = useMemo(
    () => [...new Set(all.map((t) => t.chainName).filter((c): c is string => !!c))].sort(),
    [all],
  )
  const rows = useMemo(() => filterRunning(all, { knight, chain, status }), [all, knight, chain, status])
  const selected = selectedId ? tasks.get(selectedId) : undefined
  // Remember the last registry entry so the drawer keeps its header once the
  // task finishes and leaves /api/running.
  const [lastSelected, setLastSelected] = useState<RunningTask | undefined>(undefined)
  useEffect(() => {
    if (selected) setLastSelected(selected)
  }, [selected])
  const hint = selected ?? (lastSelected?.taskId === selectedId ? lastSelected : undefined)

  const onRowKey = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setParam('task', id)
    }
  }

  const selectClass = 'bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-1.5 text-sm text-gray-200'

  return (
    <div>
      <PageHeader
        icon={Activity}
        title="Running"
        subtitle={<>Every in-flight task across all knight pods • {connected ? '🟢 Live' : '🔴 Disconnected'}</>}
      >
        <RefreshButton onClick={refresh} loading={loading} />
      </PageHeader>

      <div className="grid grid-cols-3 gap-4 mb-6 max-w-xl">
        <StatCard label="Running" value={counts.running} color="text-blue-400" />
        <StatCard label="Stale" value={counts.stale} color={counts.stale > 0 ? 'text-yellow-400' : 'text-gray-400'} />
        <StatCard label="Lost" value={counts.lost} color={counts.lost > 0 ? 'text-red-400' : 'text-gray-400'} />
      </div>

      {unavailable && (
        <div className="mb-6">
          <ErrorBanner>This API does not report running tasks yet (GET /api/running not found).</ErrorBanner>
        </div>
      )}

      <div className="flex flex-wrap gap-3 mb-4">
        <label className="flex items-center gap-2 text-sm text-gray-400">
          Knight
          <select aria-label="Filter by knight" className={selectClass} value={knight} onChange={(e) => setParam('knight', e.target.value)}>
            <option value="">All</option>
            {knights.map((k) => <option key={k} value={k}>{k}</option>)}
            {knight && !knights.includes(knight) && <option value={knight}>{knight}</option>}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          Chain
          <select aria-label="Filter by chain" className={selectClass} value={chain} onChange={(e) => setParam('chain', e.target.value)}>
            <option value="">All</option>
            {chains.map((c) => <option key={c} value={c}>{c}</option>)}
            {chain && !chains.includes(chain) && <option value={chain}>{chain}</option>}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-400">
          Status
          <select aria-label="Filter by status" className={selectClass} value={status} onChange={(e) => setParam('status', e.target.value)}>
            <option value="">All</option>
            <option value="running">Running</option>
            <option value="stale">Stale</option>
            <option value="lost">Lost</option>
          </select>
        </label>
      </div>

      <ListState loading={loading} error={error} onRetry={refresh} count={rows.length} what="running tasks" icon={Activity}
        emptyTitle={all.length === 0 ? 'Nothing is running right now.' : 'No tasks match these filters.'}>
        <>
          <span id={rowsHintId} className="sr-only">Press Enter on a row to open its details</span>
          <DataTable label="Running tasks" density="compact" describedBy={rowsHintId} columns={[
            { key: 'status', header: 'Status' },
            { key: 'knight', header: 'Knight' },
            { key: 'pod', header: 'Pod' },
            { key: 'slot', header: 'Slot' },
            { key: 'task', header: 'Task' },
            { key: 'run', header: 'Run' },
            { key: 'chain-step', header: 'Chain / step' },
            { key: 'model', header: 'Model' },
            { key: 'elapsed', header: 'Elapsed' },
            { key: 'heartbeat', header: 'Heartbeat' },
            { key: 'last-tool', header: 'Last tool' },
            { key: 'cost', header: 'Cost', align: 'right' },
          ]}>
              {rows.map((t) => (
                <tr
                  key={t.taskId}
                  data-status={t.status}
                  tabIndex={0}
                  onClick={() => setParam('task', t.taskId)}
                  onKeyDown={(e) => onRowKey(e, t.taskId)}
                  title={t.reason ? sanitizeText(t.reason) : undefined}
                  className={`border-b border-roundtable-steel/50 last:border-0 cursor-pointer hover:bg-roundtable-steel/30 focus:outline-none focus:bg-roundtable-steel/40 ${STATUS_STYLES[t.status].row}`}
                >
                  <td className="px-3 py-2"><StatusBadge status={t.status} /></td>
                  <td className="px-3 py-2 text-gray-200 capitalize">{t.knight}</td>
                  <td className="px-3 py-2 text-gray-400 font-mono text-xs">{t.pod || '—'}</td>
                  <td className="px-3 py-2 text-gray-400">{t.slot ?? '—'}</td>
                  <td className="px-3 py-2 text-gray-400 font-mono text-xs" title={t.taskId}>{t.taskId.slice(0, 12)}</td>
                  <td className="px-3 py-2 text-gray-400 font-mono text-xs" title={t.runId}>{t.runId ? t.runId.slice(0, 12) : '—'}</td>
                  <td className="px-3 py-2"><ChainCell task={t} /></td>
                  <td className="px-3 py-2 text-gray-400">{t.model || '—'}</td>
                  <td className="px-3 py-2 text-gray-300 tabular-nums">{formatRunningAge(t.startedAt, now)}</td>
                  <td className={`px-3 py-2 tabular-nums ${STATUS_STYLES[t.status].text}`}>
                    {formatRunningAge(t.lastHeartbeat, now)}
                  </td>
                  <td className="px-3 py-2 text-gray-400 max-w-[12rem] truncate">{lastToolLabel(t) || '—'}</td>
                  <td className="px-3 py-2 text-right text-roundtable-gold tabular-nums">{t.costUsd != null ? formatCost(t.costUsd) : '—'}</td>
                </tr>
              ))}
          </DataTable>
        </>
      </ListState>

      {selectedId && (
        <TaskActivityPanel
          taskId={selectedId}
          hint={hint}
          extra={selected ? <RunningExtra task={selected} now={now} /> : undefined}
          onClose={() => setParam('task', '')}
        />
      )}
    </div>
  )
}
