import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CalendarClock, ArrowLeft, Play, Pause, PlayCircle, Trash2, Copy, Check, GitBranch, Link2, Shield, Target, X } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { apiDelete, apiGet, apiGetText, apiPost } from '../lib/api'
import { formatRelativeTime, until } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { SafeMarkdown } from '../components/SafeMarkdown'
import { PageHeader, RefreshButton, ErrorBanner, Spinner, EmptyState, Modal, TableBadge } from '../components/ui'
import {
  RUN_HISTORY_LIMIT, scheduleApi, sortRunsNewestFirst, formatSeconds, formatCostUSD, outcomeLabel, outcomeClass,
  runResultText, type Schedule, type ScheduleRun, type ScheduleRunResult, type ScheduleRunNow, type ScheduleSuspendState,
} from '../lib/schedules'

const POLL_MS = 15000

function absolute(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : ''
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${outcomeClass(outcome)}`}>{outcomeLabel(outcome)}</span>
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
          ? <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">Suspended</span>
          : <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-0.5 text-xs text-green-300">Active</span>}
        {s.managedBy === 'git' && (
          <span className="inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-xs text-purple-300">
            <GitBranch className="w-3 h-3" aria-hidden /> managed in Git
          </span>
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
          <dd className="text-white" title={absolute(s.nextRunAt)}>{s.suspended ? '—' : until(s.nextRunAt)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Last run</dt>
          <dd className="flex items-center gap-2 text-white" title={absolute(s.lastRunAt)}>
            {s.lastRunAt ? formatRelativeTime(s.lastRunAt) : '—'}
            {s.lastResult && <OutcomeBadge outcome={s.lastResult.outcome} />}
          </dd>
        </div>
      </dl>
    </section>
  )
}

const btn = 'inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50'

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
    return `Run ${r.state}${r.reason ? `: ${r.reason}` : ''}`
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
        <button className={`${btn} border-roundtable-gold/40 bg-roundtable-gold/10 text-roundtable-gold hover:bg-roundtable-gold/20`}
          disabled={busy} onClick={() => setConfirm('run')}>
          <Play className="w-4 h-4" aria-hidden /> Run now
        </button>
        {s.suspended ? (
          <button className={`${btn} border-green-500/30 text-green-300 hover:bg-green-500/10`} disabled={busy} onClick={() => setSuspended(false)}>
            <PlayCircle className="w-4 h-4" aria-hidden /> Resume
          </button>
        ) : (
          <button className={`${btn} border-amber-500/30 text-amber-300 hover:bg-amber-500/10`} disabled={busy} onClick={() => setSuspended(true)}>
            <Pause className="w-4 h-4" aria-hidden /> Suspend
          </button>
        )}
        {s.managedBy !== 'git' && (
          <button className={`${btn} border-red-500/30 text-red-300 hover:bg-red-500/10`} disabled={busy} onClick={() => setConfirm('delete')}>
            <Trash2 className="w-4 h-4" aria-hidden /> Delete
          </button>
        )}
      </div>
      {message && <p role="status" className="mt-2 text-sm text-gray-300">{sanitizeText(message)}</p>}
      {error && <div className="mt-2"><ErrorBanner>{sanitizeText(error)}</ErrorBanner></div>}

      {confirm === 'run' && (
        <Modal title={`Run ${s.name} now?`} icon={<Play className="w-5 h-5 text-roundtable-gold" />} onClose={() => setConfirm(null)}>
          <div className="space-y-4 p-6">
            <p className="text-sm text-gray-400">This fires the schedule once now, even while it is suspended:</p>
            <p className="flex items-center gap-2 rounded-lg bg-black/30 p-3 text-sm text-white" data-testid="run-now-task">
              <TargetIcon kind={s.target.kind} /> {sanitizeText(s.target.summary)}
            </p>
            <div className="flex justify-end gap-2">
              <button className={`${btn} border-roundtable-steel text-gray-300`} onClick={() => setConfirm(null)}>Cancel</button>
              <button className={`${btn} border-roundtable-gold/40 bg-roundtable-gold/10 text-roundtable-gold`} disabled={busy} onClick={runNow}>Run</button>
            </div>
          </div>
        </Modal>
      )}
      {confirm === 'delete' && (
        <Modal title={`Delete ${s.name}?`} icon={<Trash2 className="w-5 h-5 text-red-400" />} onClose={() => setConfirm(null)}>
          <div className="space-y-4 p-6">
            <p className="text-sm text-gray-400">The schedule is removed. Runs it already started are kept until their own TTL.</p>
            <div className="flex justify-end gap-2">
              <button className={`${btn} border-roundtable-steel text-gray-300`} onClick={() => setConfirm(null)}>Cancel</button>
              <button className={`${btn} border-red-500/30 bg-red-500/10 text-red-300`} disabled={busy} onClick={remove}>Delete</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
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
      <table className="w-full text-sm">
        <thead className="bg-black/20 text-left text-gray-400">
          <tr>
            <th className="px-3 py-2">Time</th>
            <th className="px-3 py-2">Outcome</th>
            <th className="px-3 py-2">Duration</th>
            <th className="px-3 py-2">Cost</th>
            <th className="px-3 py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => (
            <tr key={`${r.time}-${r.run ?? r.key ?? i}`}
              className={`border-t border-roundtable-steel/50 ${r.run && r.run === selected ? 'bg-roundtable-gold/5' : ''}`}>
              <td className="px-3 py-2 text-white" title={absolute(r.time)}>{absolute(r.time)} <span className="text-gray-500">({formatRelativeTime(r.time)})</span></td>
              <td className="px-3 py-2">
                <OutcomeBadge outcome={r.outcome} />
                {r.reason && <span className="ml-2 text-xs text-gray-400">{sanitizeText(r.reason)}</span>}
              </td>
              <td className="px-3 py-2 text-gray-300">{formatSeconds(r.durationSeconds)}</td>
              <td className="px-3 py-2 text-gray-300">{formatCostUSD(r.costUSD)}</td>
              <td className="px-3 py-2">
                {r.run && r.resultAvailable ? (
                  <button className="text-roundtable-gold hover:underline" onClick={() => onSelect(r.run!)} aria-label={`View result of ${r.run}`}>
                    View
                  </button>
                ) : <span className="text-gray-600">—</span>}
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
          {result && <OutcomeBadge outcome={result.phase === 'Succeeded' ? 'succeeded' : result.phase === 'Failed' ? 'failed' : result.phase} />}
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
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')

  useEffect(() => {
    let live = true
    apiGetText(scheduleApi(namespace, name, 'manifest'))
      .then((y) => { if (live) setYaml(y) })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Failed to load the manifest') })
    return () => { live = false }
  }, [namespace, name])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])

  const copy = async () => {
    if (yaml == null) return
    setCopyError('')
    try {
      await navigator.clipboard.writeText(yaml)
      setCopied(true)
    } catch {
      setCopyError('Copy failed: the browser denied clipboard access')
    }
  }

  if (error) return <ErrorBanner>Failed to load the manifest: {sanitizeText(error)}</ErrorBanner>
  if (yaml == null) return <div className="flex justify-center py-8"><Spinner /></div>
  return (
    <section aria-label="yaml" className="rounded-xl border border-roundtable-steel bg-roundtable-slate p-4">
      <div className="mb-2 flex items-center justify-end gap-2">
        {copyError && <span className="text-xs text-red-400">{copyError}</span>}
        <button onClick={copy} className={`${btn} border-roundtable-steel text-gray-300 hover:text-white`}>
          {copied ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />}
          {copied ? 'Copied' : 'Copy YAML'}
        </button>
      </div>
      <pre data-testid="schedule-yaml" className="overflow-auto whitespace-pre rounded-lg bg-black/30 p-3 text-xs text-gray-200">{yaml}</pre>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

type Tab = 'runs' | 'yaml'

export function ScheduleDetailPage() {
  const { namespace = '', name = '' } = useParams()
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
