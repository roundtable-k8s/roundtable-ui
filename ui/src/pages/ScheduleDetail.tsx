import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CalendarClock, ArrowLeft, Play, Pause, PlayCircle, Trash2, GitBranch, Link2, Shield, Target, X, Pencil } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { apiDelete, apiGet, apiGetText, apiPost } from '../lib/api'
import { formatDateTime, formatRelativeTime, until } from '../lib/format'
import { sanitizeText, safeUrl } from '../lib/untrusted'
import { SafeMarkdown } from '../components/SafeMarkdown'
import { TraceLink } from '../components/TraceLink'
import { PageHeader, RefreshButton, ErrorBanner, Spinner, EmptyState, TableBadge, Badge, Button, LinkButton, ConfirmDialog, CopyButton } from '../components/ui'
import {
  RUN_HISTORY_LIMIT, describePolicy, describeDeadline, describeSuspension, scheduleApi, scheduleEditPath, scheduleNextUrl, type ScheduleNextRuns, sortRunsNewestFirst, formatSeconds, formatCostUSD, outcomeLabel, outcomeTone,
  runResultText, runResultOutcome, prLabel, describeTurns, type Schedule, type ScheduleRun, type ScheduleRunResult, type ScheduleRunNow, type ScheduleSuspendState,
} from '../lib/schedules'

const POLL_MS = 15000

function OutcomeBadge({ outcome }: { outcome: string }) {
  return <Badge tone={outcomeTone(outcome)}>{outcomeLabel(outcome)}</Badge>
}

function TargetIcon({ kind }: { kind: string }) {
  const Icon = kind === 'chain' ? Link2 : kind === 'knight' ? Shield : Target
  return <Icon className="w-4 h-4 text-roundtable-gold" aria-label={kind} />
}

/* ------------------------------------------------------------------ */
/* Summary and actions                                                 */
/* ------------------------------------------------------------------ */

function ScheduleSummary({ s }: { s: Schedule }) {
  return (
    <section aria-label="summary" className="mb-4 rounded-xl border border-roundtable-steel bg-roundtable-slate p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <TableBadge table={s.table} />
        {s.suspended
          ? <Badge tone="amber">Suspended</Badge>
          : <Badge tone="green">Active</Badge>}
        {s.managedBy === 'git' && (
          <Badge tone="purple" icon={<GitBranch className="w-3 h-3" aria-hidden />}>managed in Git</Badge>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-gray-500">Target</dt>
          <dd className="flex items-center gap-2 text-white"><TargetIcon kind={s.target.kind} /> {sanitizeText(s.target.summary)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Cadence</dt>
          <dd className="text-white" title={`${s.cron} (${s.timeZone})`}>
            {s.description || `cron ${s.cron}`} <span className="text-gray-500">· {s.cron} · {s.timeZone}</span>
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Next run</dt>
          <dd className="text-white" title={s.nextRunAt ? formatDateTime(s.nextRunAt) : ''}>{s.suspended ? '—' : until(s.nextRunAt)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Last run</dt>
          <dd className="flex items-center gap-2 text-white" title={s.lastRunAt ? formatDateTime(s.lastRunAt) : ''}>
            {s.lastRunAt ? formatRelativeTime(s.lastRunAt) : '—'}
            {s.lastResult && <OutcomeBadge outcome={s.lastResult.outcome} />}
          </dd>
        </div>
      </dl>
      {(s.concurrency || s.startingDeadlineSeconds !== undefined || describeSuspension(s)) && (
        <section aria-label="policy" className="mt-4 border-t border-roundtable-steel pt-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-gray-500">Policy</dt>
              <dd className="text-white">{describePolicy(s) || '—'}</dd>
            </div>
            <div>
              <dt className="text-gray-500">Starting deadline</dt>
              <dd className="text-white">{describeDeadline(s)}</dd>
            </div>
            {describeSuspension(s) && (
              <div>
                <dt className="text-gray-500">Suspension source</dt>
                <dd className="text-white">{describeSuspension(s)}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
    </section>
  )
}

/**
 * Run now, Suspend / Resume for every schedule; Delete only when the schedule
 * is not managed in Git (the gateway refuses it with 409 anyway).
 */
export function ScheduleActions({ s, onChanged, onDeleted }: {
  s: Schedule
  onChanged: () => void
  onDeleted: () => void
}) {
  const [confirm, setConfirm] = useState<'run' | 'delete' | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const act = async (fn: () => Promise<string>) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      setMessage(await fn())
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(false)
      setConfirm(null)
    }
  }

  const runNow = () => act(async () => {
    const r = await apiPost<ScheduleRunNow>(scheduleApi(s.namespace, s.name, 'run'), {})
    if (r.state === 'started') return r.run ? `Started run ${r.run}` : 'Run started'
    if (r.state === 'pending') return 'Run requested; the operator has not started it yet'
    return `Run ${r.state}${r.skipReason ? `: ${r.skipReason}` : ''}`
  })
  const setSuspended = (suspend: boolean) => act(async () => {
    const r = await apiPost<ScheduleSuspendState>(scheduleApi(s.namespace, s.name, suspend ? 'suspend' : 'resume'), {})
    return r.message || (r.suspended ? 'Suspended' : 'Resumed')
  })
  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await apiDelete(scheduleApi(s.namespace, s.name))
      setConfirm(null)
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
      setConfirm(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-4" data-testid="schedule-actions">
      <div className="flex flex-wrap items-center gap-2">
        <Button tone="gold" disabled={busy} onClick={() => setConfirm('run')}>
          <Play className="w-4 h-4" aria-hidden /> Run now
        </Button>
        {s.suspended ? (
          <Button tone="green" disabled={busy} onClick={() => setSuspended(false)}>
            <PlayCircle className="w-4 h-4" aria-hidden /> Resume
          </Button>
        ) : (
          <Button tone="amber" disabled={busy} onClick={() => setSuspended(true)}>
            <Pause className="w-4 h-4" aria-hidden /> Suspend
          </Button>
        )}
        {s.managedBy !== 'git' && (
          <LinkButton to={scheduleEditPath(s)}>
            <Pencil className="w-4 h-4" aria-hidden /> Edit
          </LinkButton>
        )}
        {s.managedBy !== 'git' && (
          <Button tone="red" disabled={busy} onClick={() => setConfirm('delete')}>
            <Trash2 className="w-4 h-4" aria-hidden /> Delete
          </Button>
        )}
      </div>
      {message && <p role="status" className="mt-2 text-sm text-gray-300">{sanitizeText(message)}</p>}
      {error && <div className="mt-2"><ErrorBanner>{sanitizeText(error)}</ErrorBanner></div>}

      {confirm === 'run' && (
        <ConfirmDialog title={`Run ${s.name} now?`} icon={<Play className="w-5 h-5 text-roundtable-gold" />}
          confirmLabel="Run" working={busy} onCancel={() => setConfirm(null)} onConfirm={runNow}>
          <p className="text-sm text-gray-400">This fires the schedule once now, even while it is suspended:</p>
          <p className="flex items-center gap-2 rounded-lg bg-black/30 p-3 text-sm text-white" data-testid="run-now-task">
            <TargetIcon kind={s.target.kind} /> {sanitizeText(s.target.summary)}
          </p>
        </ConfirmDialog>
      )}
      {confirm === 'delete' && (
        <ConfirmDialog title={`Delete ${s.name}?`} icon={<Trash2 className="w-5 h-5 text-red-400" />}
          confirmLabel="Delete" tone="red" working={busy} onCancel={() => setConfirm(null)} onConfirm={remove}>
          <p className="text-sm text-gray-400">The schedule is removed. Runs it already started are kept until their own TTL.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

export function NextRuns({ namespace, name, suspended }: { namespace: string; name: string; suspended: boolean }) {
  const { data, error } = usePolledFetch<ScheduleNextRuns | null>(scheduleNextUrl(namespace, name, 5), POLL_MS, null)
  const times = data?.times ?? []
  return (
    <section aria-label="next runs" className="mb-4 rounded-xl border border-roundtable-steel bg-roundtable-slate p-4">
      <h3 className="mb-2 text-sm font-semibold text-white">Next runs</h3>
      {(suspended || data?.suspended) && <p className="mb-2 text-xs text-amber-300">suspended: these ticks will not fire</p>}
      {error && <p className="text-xs text-gray-500">Next runs unavailable: {sanitizeText(error)}</p>}
      {!error && data && times.length === 0 && <p className="text-xs text-gray-500">No upcoming runs.</p>}
      {times.length > 0 && (
        <ol className="space-y-0.5 text-sm text-gray-200">
          {times.map((t) => (
            <li key={t.time} title={t.time}>{sanitizeText(t.local)} <span className="text-gray-500">· {sanitizeText(t.time)} UTC</span></li>
          ))}
        </ol>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Run history and result viewer                                       */
/* ------------------------------------------------------------------ */

export function RunHistory({ namespace, name, selected, onSelect }: {
  namespace: string
  name: string
  selected: string | null
  onSelect: (run: string) => void
}) {
  const url = `${scheduleApi(namespace, name, 'runs')}?limit=${RUN_HISTORY_LIMIT}`
  const { data, loading, error } = usePolledFetch<{ runs: ScheduleRun[] } | null>(url, POLL_MS, null)
  const runs = sortRunsNewestFirst(data?.runs ?? [])

  if (error) return <ErrorBanner>Failed to load run history: {error}</ErrorBanner>
  if (loading && !data) return <div className="flex justify-center py-8"><Spinner /></div>
  if (runs.length === 0) return <EmptyState icon={CalendarClock} title="No runs yet" sub="Runs appear here once the schedule fires or is run now." />

  return (
    <section aria-label="run history" className="overflow-x-auto rounded-xl border border-roundtable-steel">
      <table aria-label="Run history" className="w-full text-sm">
        <thead className="bg-black/20 text-left text-gray-400">
          <tr>
            <th scope="col" className="px-3 py-2">Time</th>
            <th scope="col" className="px-3 py-2">Outcome</th>
            <th scope="col" className="px-3 py-2">Duration</th>
            <th scope="col" className="px-3 py-2">Cost</th>
            <th scope="col" className="px-3 py-2">Turns / tool calls</th>
            <th scope="col" className="px-3 py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={`${r.time}-${r.run ?? r.key ?? i}`}
              className={`border-t border-roundtable-steel/50 ${r.run && r.run === selected ? 'bg-roundtable-gold/5' : ''}`}>
              <td className="px-3 py-2 text-white" title={r.time ? formatDateTime(r.time) : ''}>{r.time ? formatDateTime(r.time) : ''} <span className="text-gray-500">({formatRelativeTime(r.time)})</span></td>
              <td className="px-3 py-2">
                <OutcomeBadge outcome={r.outcome} />
                {r.reason && <span className="ml-2 text-xs text-gray-400">{sanitizeText(r.reason)}</span>}
              </td>
              <td className="px-3 py-2 text-gray-300">{formatSeconds(r.durationSeconds)}</td>
              <td className="px-3 py-2 text-gray-300">{formatCostUSD(r.costUSD)}</td>
              <td className="px-3 py-2 text-gray-300">{describeTurns(r) || <span className="text-gray-600">—</span>}</td>
              <td className="px-3 py-2">
                <div className="flex flex-col items-start gap-1">
                  {r.run && r.resultAvailable ? (
                    <button className="text-roundtable-gold hover:underline" onClick={() => onSelect(r.run!)} aria-label={`View result of ${r.run}`}>
                      View
                    </button>
                  ) : <span className="text-gray-600">—</span>}
                  <TraceLink traceId={r.traceId} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export function RunResultViewer({ namespace, name, run, onClose }: {
  namespace: string
  name: string
  run: string
  onClose: () => void
}) {
  const [result, setResult] = useState<ScheduleRunResult | null>(null)
  const [error, setError] = useState('')
  const [raw, setRaw] = useState(false)

  useEffect(() => {
    let live = true
    setResult(null)
    setError('')
    apiGet<ScheduleRunResult>(scheduleApi(namespace, name, 'runs', run))
      .then((r) => { if (live) setResult(r) })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Failed to load the result') })
    return () => { live = false }
  }, [namespace, name, run])

  const text = result ? runResultText(result) : ''
  const truncated = result?.outputTruncated || result?.steps?.some((s) => s.outputTruncated)

  return (
    <section aria-label="run result" className="mt-4 rounded-xl border border-roundtable-steel bg-roundtable-slate p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-semibold text-white">
          Result of <code className="text-roundtable-gold">{run}</code>
          {result && <OutcomeBadge outcome={runResultOutcome(result)} />}
        </h3>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="result format" className="inline-flex overflow-hidden rounded-lg border border-roundtable-steel text-xs">
            <button className={`px-3 py-1 ${!raw ? 'bg-roundtable-gold/20 text-roundtable-gold' : 'text-gray-400'}`} aria-pressed={!raw} onClick={() => setRaw(false)}>Rendered</button>
            <button className={`px-3 py-1 ${raw ? 'bg-roundtable-gold/20 text-roundtable-gold' : 'text-gray-400'}`} aria-pressed={raw} onClick={() => setRaw(true)}>Raw</button>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Close result"><X className="w-4 h-4" /></button>
        </div>
      </div>
      {error && <ErrorBanner>Failed to load the result: {sanitizeText(error)}</ErrorBanner>}
      {!result && !error && <div className="flex justify-center py-6"><Spinner size="sm" /></div>}
      {result && !text && <p className="text-sm text-gray-500">The run produced no output.</p>}
      {result && text && (raw
        ? <pre data-testid="result-raw" className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-lg bg-black/30 p-3 text-xs text-gray-200">{sanitizeText(text)}</pre>
        : <div data-testid="result-rendered" className="prose prose-invert prose-sm max-w-none max-h-[32rem] overflow-auto"><SafeMarkdown>{text}</SafeMarkdown></div>)}
      {result?.task && !!(result.task.model || result.task.verdict || result.task.prs?.length) && (
        <dl aria-label="task details" className="mt-3 space-y-1 text-xs text-gray-300">
          {result.task.model && <div><dt className="inline text-gray-500">Model: </dt><dd className="inline">{sanitizeText(result.task.model)}</dd></div>}
          {result.task.verdict && <div><dt className="inline text-gray-500">Verdict: </dt><dd className="inline">{sanitizeText(result.task.verdict)}</dd></div>}
          {!!result.task.prs?.length && (
            <div><dt className="inline text-gray-500">PRs: </dt>
              <dd className="inline">{result.task.prs.map((pr, i) => {
                const label = sanitizeText(prLabel(pr) || pr.url || 'pull request')
                const href = safeUrl(pr.url)
                return href
                  ? <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="mr-2 break-all text-roundtable-gold hover:underline">{label}</a>
                  : <span key={i} className="mr-2 break-all">{label}</span>
              })}</dd>
            </div>
          )}
        </dl>
      )}
      {truncated && <p className="mt-2 text-xs text-amber-300">The output was truncated by the gateway.</p>}
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* YAML                                                                */
/* ------------------------------------------------------------------ */

export function ScheduleYaml({ namespace, name }: { namespace: string; name: string }) {
  const [yaml, setYaml] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    // Drop what belongs to the previous schedule before fetching this one.
    setYaml(null)
    setError('')
    let live = true
    apiGetText(scheduleApi(namespace, name, 'manifest'))
      .then((y) => { if (live) setYaml(y) })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Failed to load the manifest') })
    return () => { live = false }
  }, [namespace, name])

  if (error) return <ErrorBanner>Failed to load the manifest: {sanitizeText(error)}</ErrorBanner>
  if (yaml == null) return <div className="flex justify-center py-8"><Spinner /></div>
  return (
    <section aria-label="yaml" className="rounded-xl border border-roundtable-steel bg-roundtable-slate p-4">
      <div className="mb-2 flex items-center justify-end gap-2">
        <CopyButton text={yaml} label="Copy YAML" />
      </div>
      <pre data-testid="schedule-yaml" className="overflow-auto whitespace-pre rounded-lg bg-black/30 p-3 text-xs text-gray-200">{yaml}</pre>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

type Tab = 'runs' | 'yaml'

/**
 * Keyed by namespace/name: opening another schedule (command palette, back or
 * forward) starts from a clean state, so the tab, selected run, action message
 * and open confirm dialog never carry over from the previous schedule.
 */
export function ScheduleDetailPage() {
  const { namespace = '', name = '' } = useParams()
  return <ScheduleDetailBody key={`${namespace}/${name}`} namespace={namespace} name={name} />
}

function ScheduleDetailBody({ namespace, name }: { namespace: string; name: string }) {
  const navigate = useNavigate()
  const { data, loading, error, refresh } = usePolledFetch<Schedule | null>(scheduleApi(namespace, name), POLL_MS, null)
  const [tab, setTab] = useState<Tab>('runs')
  const [selectedRun, setSelectedRun] = useState<string | null>(null)

  const tabCls = (t: Tab) => `px-4 py-2 text-sm border-b-2 ${tab === t ? 'border-roundtable-gold text-roundtable-gold' : 'border-transparent text-gray-400 hover:text-white'}`

  return (
    <div>
      <PageHeader icon={CalendarClock} title={name} subtitle="Schedule">
        <RefreshButton onClick={refresh} loading={loading} />
      </PageHeader>
      <Link to="/schedules" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
        <ArrowLeft className="w-4 h-4" aria-hidden /> All schedules
      </Link>
      {error && <div className="mb-4"><ErrorBanner>Failed to load schedule: {error}</ErrorBanner></div>}
      {loading && !data && !error && <div className="flex justify-center py-12"><Spinner /></div>}
      {data && (
        <>
          <ScheduleSummary s={data} />
          <NextRuns namespace={data.namespace} name={data.name} suspended={data.suspended} />
          <ScheduleActions s={data} onChanged={refresh} onDeleted={() => navigate('/schedules')} />
          <div role="tablist" className="mb-4 flex border-b border-roundtable-steel">
            <button role="tab" aria-selected={tab === 'runs'} className={tabCls('runs')} onClick={() => setTab('runs')}>Run history</button>
            <button role="tab" aria-selected={tab === 'yaml'} className={tabCls('yaml')} onClick={() => setTab('yaml')}>YAML</button>
          </div>
          {tab === 'runs' && (
            <>
              <RunHistory namespace={data.namespace} name={data.name} selected={selectedRun} onSelect={setSelectedRun} />
              {selectedRun && (
                <RunResultViewer namespace={data.namespace} name={data.name} run={selectedRun} onClose={() => setSelectedRun(null)} />
              )}
            </>
          )}
          {tab === 'yaml' && <ScheduleYaml namespace={data.namespace} name={data.name} />}
        </>
      )}
    </div>
  )
}
