import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, ExternalLink, GitBranch, Link2, Pencil, Plus, Shield, Target, Play, Pause, PlayCircle, Trash2, Zap } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useTableFilter } from '../hooks/useTableFilter'
import { inTable, withTable } from '../lib/tables'
import { apiDelete, apiPost } from '../lib/api'
import { PageHeader, RefreshButton, ErrorBanner, Spinner, EmptyState, TableBadge, Modal } from '../components/ui'
import { formatRelativeTime, until } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { chainLink, type Trigger } from '../lib/triggers'
import {
  firstLine, scheduleEditPath, scheduleKey, scheduleApi, scheduleLink, targetName, SCHEDULE_DOCS_URL,
  type Schedule, type ScheduleList, type ScheduleRunNow, type ScheduleSuspendState,
} from '../lib/schedules'

const POLL_MS = 10000

const btn = 'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50'
const btnGold = `${btn} border-roundtable-gold/30 bg-roundtable-gold/10 text-roundtable-gold hover:bg-roundtable-gold/20`
const btnGray = `${btn} border-roundtable-steel bg-roundtable-navy text-gray-300 hover:text-white`
const btnLink = `${btnGray} no-underline`
const btnRed = `${btn} border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20`

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
      <span className="block text-xs text-gray-500">{new Date(iso).toLocaleString()}</span>
    </span>
  )
}

function SchedulesEmpty({ filtered }: { filtered: boolean }) {
  return (
    <div data-testid="schedules-empty">
      <EmptyState
        icon={CalendarClock}
        title={filtered ? 'No schedules match the filter' : 'No schedules yet'}
        sub="A schedule runs a task on a knight, a Chain or a Mission on a cron cadence. It is a Trigger with a schedule source: write it as YAML in Git (applied by Flux) or create it through the gateway."
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
                </td>
                <td className="px-4 py-3"><NextRun iso={s.suspended ? undefined : s.nextRunAt} /></td>
                <td className="px-4 py-3"><LastRun s={s} /></td>
                <td className="px-4 py-3">
                  {s.suspended
                    ? <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">Suspended</span>
                    : <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-xs text-green-300">Active</span>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-1">
                    <button className={btnGold} disabled={busy === key} onClick={() => onRun(s)} aria-label={`Run ${s.name} now`}>
                      <Play className="w-3 h-3" aria-hidden /> Run now
                    </button>
                    {s.suspended
                      ? <button className={btnGray} disabled={busy === key} onClick={() => onResume(s)} aria-label={`Resume ${s.name}`}>
                          <PlayCircle className="w-3 h-3" aria-hidden /> Resume
                        </button>
                      : <button className={btnGray} disabled={busy === key} onClick={() => onSuspend(s)} aria-label={`Suspend ${s.name}`}>
                          <Pause className="w-3 h-3" aria-hidden /> Suspend
                        </button>}
                    {s.managedBy !== 'git' && (
                      <Link to={scheduleEditPath(s)} className={btnLink} aria-label={`Edit ${s.name}`}>
                        <Pencil className="w-3 h-3" aria-hidden /> Edit
                      </Link>
                    )}
                    {s.managedBy !== 'git' && (
                      <button className={btnRed} disabled={busy === key} onClick={() => onDelete(s)} aria-label={`Delete ${s.name}`}>
                        <Trash2 className="w-3 h-3" aria-hidden /> Delete
                      </button>
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
  return `${name} was skipped${r.reason ? `: ${r.reason}` : ''}`
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
    <Modal onClose={onCancel} title={run ? `Run ${s.name} now?` : `Delete ${s.name}?`}
      icon={run ? <Play className="w-5 h-5 text-roundtable-gold" /> : <Trash2 className="w-5 h-5 text-red-400" />}>
      <div className="p-6 space-y-4 text-sm" data-testid={run ? 'run-now-dialog' : 'delete-dialog'}>
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
        <div className="flex justify-end gap-2">
          <button className={btnGray} onClick={onCancel} disabled={working}>Cancel</button>
          <button className={run ? btnGold : btnRed} onClick={onConfirm} disabled={working}>
            {working ? 'Working…' : run ? 'Run now' : 'Delete'}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export function SchedulesPage() {
  const { table } = useTableFilter()
  const { data, loading, error, refresh } = usePolledFetch<ScheduleList>(withTable('/api/schedules', table), POLL_MS, { schedules: [] })
  // Task text is not in the gateway's schedule view: read it from the Triggers.
  const { data: triggers } = usePolledFetch<Trigger[]>('/api/triggers', POLL_MS, [])
  const [knight, setKnight] = useState('')
  const [pending, setPending] = useState<Pending>(null)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const tasks = useMemo(() => {
    const m: Record<string, string> = {}
    for (const t of triggers ?? []) if (t.task) m[`${t.namespace}/${t.name}`] = t.task
    return m
  }, [triggers])

  const all = useMemo(() => (data?.schedules ?? []).filter((s) => inTable(table, s.table)), [data, table])
  const knights = useMemo(() => [...new Set(all.map((s) => s.target.knight).filter((k): k is string => !!k))].sort(), [all])
  const shown = knight ? all.filter((s) => s.target.knight === knight) : all

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
      <PageHeader icon={CalendarClock} title="Schedules" subtitle="What runs on a cadence across the fleet">
        <Link to="/triggers" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
          <Zap className="w-4 h-4" aria-hidden /> All triggers
        </Link>
        <RefreshButton onClick={refresh} loading={loading} />
        <Link to="/schedules/new" className="inline-flex items-center gap-1.5 rounded-lg border border-roundtable-gold/30 bg-roundtable-gold/10 px-3 py-1.5 text-sm font-medium text-roundtable-gold hover:bg-roundtable-gold/20">
          <Plus className="w-4 h-4" aria-hidden /> New schedule
        </Link>
      </PageHeader>

      {notice && (
        <div role="status" data-testid="schedule-notice"
          className={`mb-4 rounded-lg border px-3 py-2 text-sm ${notice.ok ? 'border-green-500/30 bg-green-500/10 text-green-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>
          {sanitizeText(notice.text)}
        </div>
      )}
      {error && <div className="mb-4"><ErrorBanner>Failed to load schedules: {error}</ErrorBanner></div>}

      {knights.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          <label htmlFor="schedule-knight" className="text-xs text-gray-400">Knight</label>
          <select id="schedule-knight" value={knight} onChange={(e) => setKnight(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-2 py-1 text-sm text-white">
            <option value="">All knights</option>
            {knights.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
      )}

      {loading && schedules.length === 0 && !error && <div className="flex justify-center py-12"><Spinner /></div>}
      {!loading && !error && shown.length === 0 && <SchedulesEmpty filtered={schedules.length > 0} />}
      {shown.length > 0 && (
        <SchedulesTable schedules={shown} tasks={tasks} showTable={!table} busy={busy}
          onRun={(s) => setPending({ kind: 'run', schedule: s })}
          onSuspend={suspend} onResume={resume}
          onDelete={(s) => setPending({ kind: 'delete', schedule: s })} />
      )}

      {pending && (
        <ConfirmDialog pending={pending} task={sanitizeText(tasks[scheduleKey(pending.schedule)])}
          working={busy === scheduleKey(pending.schedule)}
          onCancel={() => setPending(null)} onConfirm={confirm} />
      )}
    </div>
  )
}
