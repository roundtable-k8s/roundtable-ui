import { useMemo, useState } from 'react'
import { useUrlParam } from '../hooks/useUrlParam'
import { Link } from 'react-router-dom'
import { CalendarClock, ExternalLink, GitBranch, Link2, Pencil, Plus, Shield, Target, Play, Pause, PlayCircle, Trash2, Zap } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useTableFilter } from '../hooks/useTableFilter'
import { inTable, withTable } from '../lib/tables'
import { apiDelete, apiPost } from '../lib/api'
import { PageHeader, RefreshButton, ErrorBanner, Spinner, EmptyState, TableBadge, Button, LinkButton, ConfirmDialog as ConfirmModal } from '../components/ui'
import { countLabel, formatDateTime, formatRelativeTime, until } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { chainLink, type Trigger } from '../lib/triggers'
import {
  describePolicy, describeSuspension, filterSchedules, firstLine, scheduleEditPath, scheduleKey, scheduleApi, scheduleLink, targetName, SCHEDULE_DOCS_URL, SCHEDULE_STATES,
  type Schedule, type ScheduleList, type ScheduleRunNow, type ScheduleSuspendState, type TableSchedulesResult,
} from '../lib/schedules'

const POLL_MS = 10000

const STATE_LABELS: Record<(typeof SCHEDULE_STATES)[number], string> = {
  all: 'All states', active: 'Active', suspended: 'Suspended', failing: 'Failing',
}

function KindIcon({ kind }: { kind: string }) {
  const Icon = kind === 'knight' ? Shield : kind === 'mission' ? Target : Link2
  return <Icon className="w-4 h-4 shrink-0 text-gray-400" aria-label={kind} />
}

function ManagedByBadge({ managedBy }: { managedBy: Schedule['managedBy'] }) {
  if (managedBy === 'git') {
    return (
      <span data-testid="managed-git" title="Change it in Git; the gateway refuses edits and deletes"
        className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300">
        <GitBranch className="w-3 h-3" aria-hidden /> managed in Git
      </span>
    )
  }
  return <span className="rounded-full border border-gray-500/30 bg-gray-500/10 px-2 py-0.5 text-xs text-gray-400">{managedBy === 'api' ? 'API' : 'other'}</span>
}

function outcomeClass(outcome: string): string {
  switch (outcome) {
    case 'succeeded': case 'started': return 'text-green-300'
    case 'failed': case 'lost': return 'text-red-300'
    case 'skipped': return 'text-amber-300'
    default: return 'text-gray-300'
  }
}

function LastRun({ s }: { s: Schedule }) {
  const r = s.lastResult
  if (!r) return <span className="text-gray-500">{s.lastRunAt ? formatRelativeTime(s.lastRunAt) : 'never'}</span>
  return (
    <span title={r.skipReason ? sanitizeText(r.skipReason) : r.time}>
      <span className="text-gray-300">{formatRelativeTime(r.time)}</span>{' '}
      <span className={outcomeClass(r.outcome)}>{r.outcome}</span>
      {r.run && s.target.kind === 'chain' && (
        <> · <Link to={chainLink(r.run)} className="font-mono text-xs text-roundtable-gold hover:underline">{r.run}</Link></>
      )}
    </span>
  )
}

function NextRun({ iso }: { iso?: string }) {
  if (!iso) return <span className="text-gray-500">—</span>
  return (
    <span>
      <span className="text-gray-200">{until(iso)}</span>
      <span className="block text-xs text-gray-500">{formatDateTime(iso)}</span>
    </span>
  )
}

function SchedulesEmpty({ filtered, total }: { filtered: boolean; total: number }) {
  return (
    <div data-testid="schedules-empty">
      <EmptyState
        icon={CalendarClock}
        title={filtered ? 'No schedules match the filter' : 'No schedules yet'}
        sub={filtered ? `0 of ${total} ${total === 1 ? 'schedule' : 'schedules'} shown. Clear the state or knight filter to see them.` : "A schedule runs a task on a knight, a Chain or a Mission on a cron cadence. It is a Trigger with a schedule source: write it as YAML in Git (applied by Flux) or create it through the gateway."}
      />
      <p className="text-center text-sm">
        <a href={SCHEDULE_DOCS_URL} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-roundtable-gold hover:underline">
          Read the docs <ExternalLink className="w-3 h-3" aria-hidden />
        </a>
      </p>
    </div>
  )
}

type Pending = { kind: 'run' | 'delete'; schedule: Schedule } | null

/** A pending "Pause all" or "Resume all" for every schedule of one table. */
type TableAction = { action: 'suspend' | 'resume'; table: string; namespace?: string; count: number } | null

function tableActionSummary(action: 'suspend' | 'resume', r: TableSchedulesResult): { text: string; details: string[] } {
  const changed = r.changed?.length ?? 0
  const unchanged = r.unchanged?.length ?? 0
  const failed = r.failed ?? []
  const text = action === 'suspend'
    ? `Paused ${changed}, ${unchanged} already paused, ${failed.length} failed`
    : `Resumed ${changed}, ${unchanged} already running, ${failed.length} failed`
  return { text, details: failed.map((f) => `${f.name}: ${f.error}`) }
}

export function SchedulesTable({ schedules, tasks, showTable, busy, onRun, onSuspend, onResume, onDelete }: {
  schedules: Schedule[]
  tasks: Record<string, string>
  showTable: boolean
  busy: string
  onRun: (s: Schedule) => void
  onSuspend: (s: Schedule) => void
  onResume: (s: Schedule) => void
  onDelete: (s: Schedule) => void
}) {
  return (
    <div className="overflow-x-auto bg-roundtable-slate border border-roundtable-steel rounded-xl">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-roundtable-steel">
            <th className="px-4 py-3 font-medium">Schedule</th>
            <th className="px-4 py-3 font-medium">Target</th>
            <th className="px-4 py-3 font-medium">Cadence</th>
            <th className="px-4 py-3 font-medium">Next run</th>
            <th className="px-4 py-3 font-medium">Last run</th>
            <th className="px-4 py-3 font-medium">State</th>
            <th className="px-4 py-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((s) => {
            const key = scheduleKey(s)
            const task = firstLine(sanitizeText(tasks[key]))
            const name = targetName(s.target)
            return (
              <tr key={key} className="border-b border-roundtable-steel/50 last:border-0 align-top">
                <td className="px-4 py-3">
                  <Link to={scheduleLink(s.namespace, s.name)} className="font-medium text-white hover:text-roundtable-gold">{s.name}</Link>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {showTable && <TableBadge table={s.table || 'none'} />}
                    <ManagedByBadge managedBy={s.managedBy} />
                  </div>
                </td>
                <td className="px-4 py-3 max-w-xs">
                  <div className="flex items-center gap-1.5">
                    <KindIcon kind={s.target.kind} />
                    {s.target.kind === 'chain' && s.target.chain
                      ? <Link to={chainLink(s.target.chain)} className="text-gray-200 hover:underline">{name}</Link>
                      : <span className="text-gray-200">{name}</span>}
                  </div>
                  {task && <div data-testid="schedule-task" className="mt-0.5 truncate text-xs text-gray-400" title={task}>{task}</div>}
                </td>
                <td className="px-4 py-3">
                  <span className="text-gray-200 underline decoration-dotted decoration-gray-600 cursor-help" title={`${s.cron} (${s.timeZone})`}>
                    {s.description || s.cron}
                  </span>
                  {describePolicy(s) && <div data-testid="schedule-policy" className="mt-0.5 text-xs text-gray-400">{describePolicy(s)}</div>}
                </td>
                <td className="px-4 py-3"><NextRun iso={s.suspended ? undefined : s.nextRunAt} /></td>
                <td className="px-4 py-3"><LastRun s={s} /></td>
                <td className="px-4 py-3">
                  {s.suspended
                    ? <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">Suspended</span>
                    : <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-xs text-green-300">Active</span>}
                  {describeSuspension(s) && <div data-testid="schedule-suspended-by" className="mt-1 text-xs text-gray-400">suspended by {describeSuspension(s)}</div>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-1">
                    <Button tone="gold" size="sm" disabled={busy === key} onClick={() => onRun(s)} aria-label={`Run ${s.name} now`}>
                      <Play className="w-3 h-3" aria-hidden /> Run now
                    </Button>
                    {s.suspended
                      ? <Button size="sm" disabled={busy === key} onClick={() => onResume(s)} aria-label={`Resume ${s.name}`}>
                          <PlayCircle className="w-3 h-3" aria-hidden /> Resume
                        </Button>
                      : <Button size="sm" disabled={busy === key} onClick={() => onSuspend(s)} aria-label={`Suspend ${s.name}`}>
                          <Pause className="w-3 h-3" aria-hidden /> Suspend
                        </Button>}
                    {s.managedBy !== 'git' && (
                      <LinkButton to={scheduleEditPath(s)} size="sm" aria-label={`Edit ${s.name}`}>
                        <Pencil className="w-3 h-3" aria-hidden /> Edit
                      </LinkButton>
                    )}
                    {s.managedBy !== 'git' && (
                      <Button tone="red" size="sm" disabled={busy === key} onClick={() => onDelete(s)} aria-label={`Delete ${s.name}`}>
                        <Trash2 className="w-3 h-3" aria-hidden /> Delete
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function runNowMessage(name: string, r: ScheduleRunNow): string {
  if (r.state === 'started') return `Started ${name}${r.run ? `: ${r.run}` : ''}`
  if (r.state === 'pending') return `Run of ${name} requested; the operator has not started it yet${r.run ? ` (${r.run})` : ''}`
  return `${name} was skipped${r.skipReason ? `: ${r.skipReason}` : ''}`
}

function TableActionDialog({ action, table, count, working, onCancel, onConfirm }: {
  action: 'suspend' | 'resume'
  table: string
  count: number
  working: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const pause = action === 'suspend'
  return (
    <ConfirmModal title={pause ? `Pause all schedules of ${table}?` : `Resume all schedules of ${table}?`}
      icon={pause ? <Pause className="w-5 h-5 text-roundtable-gold" /> : <PlayCircle className="w-5 h-5 text-roundtable-gold" />}
      confirmLabel={pause ? 'Pause all' : 'Resume all'} working={working} onCancel={onCancel} onConfirm={onConfirm} testId="table-action-dialog">
      <p className="text-gray-300">
        {pause
          ? <>Suspend {count} {count === 1 ? 'schedule' : 'schedules'} of table <span className="font-mono">{table}</span>? Nothing is deleted; Resume all undoes it.</>
          : <>Resume {count} suspended {count === 1 ? 'schedule' : 'schedules'} of table <span className="font-mono">{table}</span>? A schedule suspended in its Git spec stays suspended.</>}
      </p>
    </ConfirmModal>
  )
}

function ConfirmDialog({ pending, task, working, onCancel, onConfirm }: {
  pending: NonNullable<Pending>
  task: string
  working: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const s = pending.schedule
  const run = pending.kind === 'run'
  return (
    <ConfirmModal title={run ? `Run ${s.name} now?` : `Delete ${s.name}?`}
      icon={run ? <Play className="w-5 h-5 text-roundtable-gold" /> : <Trash2 className="w-5 h-5 text-red-400" />}
      confirmLabel={run ? 'Run now' : 'Delete'} tone={run ? 'gold' : 'red'} working={working}
      onCancel={onCancel} onConfirm={onConfirm} testId={run ? 'run-now-dialog' : 'delete-dialog'}>
      {run ? (
        <>
          <p className="text-gray-300">
            This fires the schedule once now, through its normal path (input, concurrency policy), even while it is suspended.
          </p>
          <div>
            <div className="flex items-center gap-1.5 text-gray-400 mb-1"><KindIcon kind={s.target.kind} /> {s.target.summary || targetName(s.target)}</div>
            {task
              ? <pre data-testid="run-now-task" className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-roundtable-steel bg-roundtable-navy p-3 text-xs text-gray-200">{task}</pre>
              : <p className="text-gray-500">No task text.</p>}
          </div>
        </>
      ) : (
        <p className="text-gray-300">
          This deletes the schedule <span className="font-mono">{scheduleKey(s)}</span>. Runs it already started are left to finish.
        </p>
      )}
    </ConfirmModal>
  )
}

export function SchedulesPage() {
  const { table } = useTableFilter()
  const { data, loading, error, updatedAt, refresh } = usePolledFetch<ScheduleList>(withTable('/api/schedules', table), POLL_MS, { schedules: [] })
  // Task text is not in the gateway's schedule view: read it from the Triggers.
  const { data: triggers } = usePolledFetch<Trigger[]>('/api/triggers', POLL_MS, [])
  const [knight, setKnight] = useUrlParam('knight', '')
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState('')
  const [tableAction, setTableAction] = useState<TableAction>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string; details?: string[] } | null>(null)

  const tasks = useMemo(() => {
    const m: Record<string, string> = {}
    for (const t of triggers ?? []) if (t.task) m[`${t.namespace}/${t.name}`] = t.task
    return m
  }, [triggers])

  const all = useMemo(() => (data?.schedules ?? []).filter((s) => inTable(table, s.table)), [data, table])
  const knights = useMemo(() => [...new Set(all.map((s) => s.target.knight).filter((k): k is string => !!k))].sort(), [all])
  const [state, setState] = useUrlParam('state', 'all', SCHEDULE_STATES)
  const byKnight = knight ? all.filter((s) => s.target.knight === knight) : all
  const shown = filterSchedules(byKnight, state)

  // The schedules of the selected table, and the namespace they share (if any).
  const tableNamespaces = [...new Set(all.map((s) => s.namespace))]
  const tableCount = (action: 'suspend' | 'resume') => all.filter((s) => s.suspended === (action === 'resume')).length
  const startTableAction = (action: 'suspend' | 'resume') => setTableAction({
    action, table, namespace: tableNamespaces.length === 1 ? tableNamespaces[0] : undefined, count: tableCount(action),
  })
  const confirmTableAction = async () => {
    if (!tableAction) return
    const { action, table: t, namespace } = tableAction
    setBusy(`table:${t}`)
    try {
      const r = await apiPost<TableSchedulesResult>(`/api/schedules/${action}`, namespace ? { table: t, namespace } : { table: t })
      const summary = tableActionSummary(action, r)
      setNotice({ ok: (r.failed ?? []).length === 0, text: summary.text, details: summary.details })
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : 'Request failed' })
    } finally {
      setBusy('')
      setTableAction(null)
    }
  }

  const act = async (s: Schedule, fn: () => Promise<string>) => {
    setBusy(scheduleKey(s))
    try {
      setNotice({ ok: true, text: await fn() })
      await refresh()
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : 'Request failed' })
    } finally {
      setBusy('')
    }
  }

  const suspend = (s: Schedule) => act(s, async () => {
    await apiPost<ScheduleSuspendState>(scheduleApi(s.namespace, s.name, 'suspend'), {})
    return `Suspended ${s.name}`
  })
  const resume = (s: Schedule) => act(s, async () => {
    const r = await apiPost<ScheduleSuspendState>(scheduleApi(s.namespace, s.name, 'resume'), {})
    return r.message ? `${s.name}: ${r.message}` : `Resumed ${s.name}`
  })
  const confirm = async () => {
    if (!pending) return
    const s = pending.schedule
    if (pending.kind === 'run') {
      await act(s, async () => runNowMessage(s.name, await apiPost<ScheduleRunNow>(scheduleApi(s.namespace, s.name, 'run'), {})))
    } else {
      await act(s, async () => { await apiDelete(scheduleApi(s.namespace, s.name)); return `Deleted ${s.name}` })
    }
    setPending(null)
  }

  const schedules = data?.schedules ?? []
  return (
    <div>
      <PageHeader icon={CalendarClock} title="Schedules" subtitle={[!loading && !(error && all.length === 0) && countLabel(shown.length, all.length, 'schedules'), 'What runs on a cadence across the fleet'].filter(Boolean).join(' · ')}>
        <Link to="/triggers" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
          <Zap className="w-4 h-4" aria-hidden /> All triggers
        </Link>
        {table && table !== 'none' && all.length > 0 && (
          <>
            <Button size="sm" disabled={!!busy || tableCount('suspend') === 0} onClick={() => startTableAction('suspend')}>
              <Pause className="w-3 h-3" aria-hidden /> Pause all in {table}
            </Button>
            <Button size="sm" disabled={!!busy || tableCount('resume') === 0} onClick={() => startTableAction('resume')}>
              <PlayCircle className="w-3 h-3" aria-hidden /> Resume all in {table}
            </Button>
          </>
        )}
        <RefreshButton onClick={refresh} loading={loading} updatedAt={updatedAt} />
        <Link to="/schedules/new" className="inline-flex items-center gap-1.5 rounded-lg border border-roundtable-gold/30 bg-roundtable-gold/10 px-3 py-1.5 text-sm font-medium text-roundtable-gold hover:bg-roundtable-gold/20">
          <Plus className="w-4 h-4" aria-hidden /> New schedule
        </Link>
      </PageHeader>

      {notice && (
        <div role="status" data-testid="schedule-notice"
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${notice.ok ? 'border-green-500/30 bg-green-500/10 text-green-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>
          {sanitizeText(notice.text)}
          {notice.details && notice.details.length > 0 && (
            <ul data-testid="schedule-notice-failed" className="mt-1 list-disc pl-5">
              {notice.details.map((d) => <li key={d}>{sanitizeText(d)}</li>)}
            </ul>
          )}
        </div>
      )}
      {error && <div className="mb-4"><ErrorBanner>Failed to load schedules: {error}</ErrorBanner></div>}

      <div className="mb-4 flex flex-wrap items-center gap-4">
        {knights.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="schedule-knight" className="text-xs text-gray-400">Knight</label>
            <select id="schedule-knight" value={knight} onChange={(e) => setKnight(e.target.value)}
              className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-2 py-1 text-sm text-white">
              <option value="">All knights</option>
              {knight && !knights.includes(knight) && <option value={knight}>{knight}</option>}
              {knights.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
        )}
        <div className="flex items-center gap-2">
          <label htmlFor="schedule-state" className="text-xs text-gray-400">State</label>
          <select id="schedule-state" value={state} onChange={(e) => setState(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-2 py-1 text-sm text-white">
            {SCHEDULE_STATES.map((st) => <option key={st} value={st}>{STATE_LABELS[st]}</option>)}
          </select>
        </div>
      </div>

      {loading && schedules.length === 0 && !error && <div className="flex justify-center py-12"><Spinner /></div>}
      {!loading && !error && shown.length === 0 && <SchedulesEmpty filtered={schedules.length > 0} total={all.length} />}
      {shown.length > 0 && (
        <SchedulesTable schedules={shown} tasks={tasks} showTable={!table} busy={busy}
          onRun={(s) => setPending({ kind: 'run', schedule: s })}
          onSuspend={suspend} onResume={resume}
          onDelete={(s) => setPending({ kind: 'delete', schedule: s })} />
      )}

      {tableAction && (
        <TableActionDialog action={tableAction.action} table={tableAction.table} count={tableAction.count}
          working={busy === `table:${tableAction.table}`}
          onCancel={() => setTableAction(null)} onConfirm={confirmTableAction} />
      )}
      {pending && (
        <ConfirmDialog pending={pending} task={sanitizeText(tasks[scheduleKey(pending.schedule)])}
          working={busy === scheduleKey(pending.schedule)}
          onCancel={() => setPending(null)} onConfirm={confirm} />
      )}
    </div>
  )
}
