import { useVisibleInterval } from '../hooks/useVisibleInterval'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CalendarClock, Check, Copy, GitBranch, Link2, Save, Shield, Target } from 'lucide-react'
import { apiGet, apiPost, apiPut, ApiError } from '../lib/api'
import { useCards } from '../hooks/useCards'
import { useTables } from '../hooks/useTables'
import { PageHeader, ErrorBanner, Spinner } from '../components/ui'
import { sanitizeText } from '../lib/untrusted'
import { scheduleApi, type Schedule } from '../lib/schedules'
import { CRON_PRESETS, CronError, formatInZone, nextRuns } from '../lib/cron'
import {
  buildRequest, emptyForm, fieldMessage, formFieldFor, formFromManifest, manifestYaml,
  GATEWAY_LABEL, GATEWAY_LABEL_VALUE, CALLER_ANNOTATION,
  type ConcurrencyPolicy, type FormField, type ScheduleForm, type TargetKind, type TriggerManifest,
} from '../lib/scheduleForm'
import type { Chain } from '../lib/types'

const CHAINS_URL = '/api/chains?copies=exclude&limit=500'

const input = 'w-full bg-roundtable-navy border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-roundtable-gold'
const btn = 'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50'
const btnGold = `${btn} border-roundtable-gold/30 bg-roundtable-gold/10 text-roundtable-gold hover:bg-roundtable-gold/20`
const btnGray = `${btn} border-roundtable-steel bg-roundtable-navy text-gray-300 hover:text-white`

function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  try {
    const zones = intl.supportedValuesOf?.('timeZone') ?? []
    return zones.includes('UTC') ? zones : ['UTC', ...zones]
  } catch {
    return ['UTC']
  }
}

function Field({ id, label, error, hint, children }: {
  id: string
  label: string
  error?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-gray-400 mb-1">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
      {error && <p id={`${id}-error`} role="alert" data-testid={`error-${id}`} className="mt-1 text-xs text-red-300">{sanitizeText(error)}</p>}
    </div>
  )
}

function border(error?: string): string {
  return error ? 'border-red-500/60' : 'border-roundtable-steel'
}

/** The next three run times of the form's cron in its time zone. */
export function NextRunsPreview({ cron, timeZone, now }: { cron: string; timeZone: string; now: Date }) {
  let runs: Date[] = []
  let error = ''
  try {
    runs = nextRuns(cron, timeZone, now, 3)
  } catch (e) {
    error = e instanceof CronError ? e.message : 'Cannot compute the next runs'
  }
  const zone = timeZone || 'UTC'
  return (
    <div data-testid="next-runs" className="rounded-lg border border-roundtable-steel bg-roundtable-navy/60 px-3 py-2 text-xs">
      <div className="text-gray-400 mb-1">Next runs ({zone})</div>
      {error
        ? <p className="text-amber-300">{error}</p>
        : runs.length === 0
          ? <p className="text-gray-500">No run in the next five years.</p>
          : <ol className="space-y-0.5 text-gray-200">{runs.map((r) => <li key={r.getTime()} title={r.toISOString()}>{formatInZone(r, zone)}</li>)}</ol>}
    </div>
  )
}

function KindButton({ kind, current, onSelect, icon, children }: {
  kind: TargetKind
  current: TargetKind
  onSelect: (k: TargetKind) => void
  icon: ReactNode
  children: ReactNode
}) {
  const active = kind === current
  return (
    <button type="button" role="radio" aria-checked={active} onClick={() => onSelect(kind)}
      className={`${btn} ${active ? 'border-roundtable-gold/60 bg-roundtable-gold/15 text-roundtable-gold' : 'border-roundtable-steel bg-roundtable-navy text-gray-300 hover:text-white'}`}>
      {icon} {children}
    </button>
  )
}

type Errors = Partial<Record<FormField, string>>

/**
 * Create (/schedules/new) or edit (/schedules/:namespace/:name/edit) a
 * schedule, with a live YAML preview of the Trigger it saves (#302).
 */
export function ScheduleFormPage() {
  const params = useParams<{ namespace: string; name: string }>()
  const editing = !!(params.namespace && params.name)
  const navigate = useNavigate()
  const tables = useTables()
  const { cards } = useCards()

  const [form, setForm] = useState<ScheduleForm>(() => emptyForm(params.namespace ?? ''))
  const [base, setBase] = useState<TriggerManifest | undefined>()
  const [managedBy, setManagedBy] = useState<Schedule['managedBy'] | ''>('')
  const [loading, setLoading] = useState(editing)
  const [loadError, setLoadError] = useState('')
  const [chains, setChains] = useState<Chain[]>([])
  const [errors, setErrors] = useState<Errors>({})
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => new Date())
  const zones = useMemo(timeZones, [])

  useVisibleInterval(() => setNow(new Date()), 60_000)

  useEffect(() => {
    apiGet<Chain[]>(CHAINS_URL).then((c) => setChains(Array.isArray(c) ? c : [])).catch(() => setChains([]))
  }, [])

  // A new schedule goes to the dashboard's namespace unless one is typed.
  useEffect(() => {
    if (editing) return
    apiGet<{ namespace?: string }>('/api/config')
      .then((c) => { if (c?.namespace) setForm((f) => (f.namespace ? f : { ...f, namespace: c.namespace as string })) })
      .catch(() => {})
  }, [editing])

  useEffect(() => {
    if (!editing) return
    const ref = { namespace: params.namespace as string, name: params.name as string }
    setLoading(true)
    Promise.all([
      apiGet<Schedule>(scheduleApi(ref.namespace, ref.name)),
      apiGet<TriggerManifest>(`${scheduleApi(ref.namespace, ref.name, 'manifest')}?format=json`),
    ]).then(([view, manifest]) => {
      setManagedBy(view.managedBy)
      setBase(manifest)
      setForm(formFromManifest(manifest))
    }).catch((e) => {
      setLoadError(e instanceof Error ? e.message : 'Failed to load the schedule')
    }).finally(() => setLoading(false))
  }, [editing, params.namespace, params.name])

  const set = <K extends keyof ScheduleForm>(key: K, value: ScheduleForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }))
    setErrors((e) => (e[key] || e[''] ? { ...e, [key]: undefined, '': undefined } : e))
  }

  const setKind = (kind: TargetKind) => {
    setForm((f) => ({
      ...f, kind,
      // Replace is not supported for knight and mission targets.
      concurrency: kind !== 'chain' && f.concurrency === 'Replace' ? 'Forbid' : f.concurrency,
    }))
    setErrors((e) => ({ ...e, kind: undefined, '': undefined }))
  }

  const knights = useMemo(() => {
    const names = new Set<string>()
    for (const c of cards.values()) if (!form.table || c.table === form.table) names.add(c.knight)
    if (form.knight) names.add(form.knight)
    return [...names].sort()
  }, [cards, form.table, form.knight])

  const chainNames = useMemo(() => {
    const names = new Set(chains.filter((c) => !form.table || !c.roundTableRef || c.roundTableRef === form.table).map((c) => c.name))
    if (form.chain) names.add(form.chain)
    return [...names].sort()
  }, [chains, form.table, form.chain])

  const yaml = useMemo(() => {
    try {
      return manifestYaml(form, base)
    } catch {
      return ''
    }
  }, [form, base])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(yaml)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setErrors((e) => ({ ...e, '': 'Copying to the clipboard failed; select the YAML and copy it instead.' }))
    }
  }

  const save = async () => {
    setSaving(true)
    setErrors({})
    try {
      const body = buildRequest(form, base?.spec)
      if (editing) await apiPut(scheduleApi(params.namespace as string, params.name as string), body)
      else await apiPost('/api/schedules', body)
      navigate('/schedules')
    } catch (e) {
      if (e instanceof ApiError && e.field) {
        const target = formFieldFor(e.field)
        setErrors({ [target]: target ? fieldMessage(e.message, e.field) : e.message })
      } else {
        setErrors({ '': e instanceof Error ? e.message : 'Saving failed' })
      }
    } finally {
      setSaving(false)
    }
  }

  const title = editing ? `Edit ${params.name}` : 'New schedule'
  const header = (
    <PageHeader icon={CalendarClock} title={title} subtitle="A Trigger with a schedule source: save it through the gateway, or copy the YAML and commit it to Git">
      <Link to="/schedules" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
        <ArrowLeft className="w-4 h-4" aria-hidden /> Schedules
      </Link>
    </PageHeader>
  )

  if (loading) return <div>{header}<div className="flex justify-center py-12"><Spinner /></div></div>
  if (loadError) return <div>{header}<ErrorBanner>Failed to load the schedule: {loadError}</ErrorBanner></div>
  if (managedBy === 'git') {
    return (
      <div>
        {header}
        <div data-testid="managed-in-git" className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">
          <GitBranch className="inline w-4 h-4 mr-1" aria-hidden />
          {params.namespace}/{params.name} is managed in Git: change it there. The gateway refuses edits to it.
        </div>
      </div>
    )
  }

  return (
    <div>
      {header}
      {errors[''] && <div className="mb-4"><ErrorBanner>{sanitizeText(errors[''])}</ErrorBanner></div>}

      <div className="grid gap-6 lg:grid-cols-2">
        <form className="space-y-4 bg-roundtable-slate border border-roundtable-steel rounded-xl p-5"
          onSubmit={(e) => { e.preventDefault(); void save() }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="schedule-name" label="Name" error={errors.name}>
              <input id="schedule-name" className={`${input} ${border(errors.name)}`} value={form.name} disabled={editing}
                placeholder="morning-digest" onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field id="schedule-namespace" label="Namespace" error={errors.namespace}>
              <input id="schedule-namespace" className={`${input} ${border(errors.namespace)}`} value={form.namespace} disabled={editing}
                onChange={(e) => set('namespace', e.target.value)} />
            </Field>
          </div>

          <Field id="schedule-table" label="Table" error={errors.table}
            hint={form.kind === 'mission' ? 'A mission target needs a table.' : 'Optional: by default the target Chain\'s or knight\'s table.'}>
            <select id="schedule-table" className={`${input} ${border(errors.table)}`} value={form.table} onChange={(e) => set('table', e.target.value)}>
              <option value="">No table</option>
              {[...new Set([...tables, ...(form.table ? [form.table] : [])])].sort().map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>

          <div>
            <span className="block text-xs font-medium text-gray-400 mb-1">Target</span>
            <div role="radiogroup" aria-label="Target kind" className="flex flex-wrap gap-2">
              <KindButton kind="knight" current={form.kind} onSelect={setKind} icon={<Shield className="w-4 h-4" aria-hidden />}>Task to a knight</KindButton>
              <KindButton kind="chain" current={form.kind} onSelect={setKind} icon={<Link2 className="w-4 h-4" aria-hidden />}>Chain</KindButton>
              <KindButton kind="mission" current={form.kind} onSelect={setKind} icon={<Target className="w-4 h-4" aria-hidden />}>Mission</KindButton>
            </div>
            {errors.kind && <p role="alert" data-testid="error-schedule-kind" className="mt-1 text-xs text-red-300">{sanitizeText(errors.kind)}</p>}
          </div>

          {form.kind === 'knight' && (
            <>
              <Field id="schedule-knight" label="Knight" error={errors.knight}>
                {knights.length > 0 ? (
                  <select id="schedule-knight" className={`${input} ${border(errors.knight)}`} value={form.knight} onChange={(e) => set('knight', e.target.value)}>
                    <option value="">Choose a knight…</option>
                    {knights.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                ) : (
                  <input id="schedule-knight" className={`${input} ${border(errors.knight)}`} value={form.knight} placeholder="galahad"
                    onChange={(e) => set('knight', e.target.value)} />
                )}
              </Field>
              <Field id="schedule-task" label="Task" error={errors.task} hint="A Go template: .Event.Time is the scheduled time.">
                <textarea id="schedule-task" rows={5} className={`${input} ${border(errors.task)} font-mono`} value={form.task}
                  onChange={(e) => set('task', e.target.value)} />
              </Field>
            </>
          )}

          {form.kind === 'chain' && (
            <>
              <Field id="schedule-chain" label="Chain" error={errors.chain}>
                {chainNames.length > 0 ? (
                  <select id="schedule-chain" className={`${input} ${border(errors.chain)}`} value={form.chain} onChange={(e) => set('chain', e.target.value)}>
                    <option value="">Choose a Chain…</option>
                    {chainNames.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <input id="schedule-chain" className={`${input} ${border(errors.chain)}`} value={form.chain} placeholder="daily-digest"
                    onChange={(e) => set('chain', e.target.value)} />
                )}
              </Field>
              <Field id="schedule-input" label="Input (optional)" error={errors.input} hint="A Go template rendered into the run's input; empty keeps the Chain's own.">
                <textarea id="schedule-input" rows={3} className={`${input} ${border(errors.input)} font-mono`} value={form.input}
                  onChange={(e) => set('input', e.target.value)} />
              </Field>
            </>
          )}

          {form.kind === 'mission' && (
            <>
              <Field id="schedule-objective" label="Objective" error={errors.objective} hint="A Go template, like a task.">
                <textarea id="schedule-objective" rows={4} className={`${input} ${border(errors.objective)} font-mono`} value={form.objective}
                  onChange={(e) => set('objective', e.target.value)} />
              </Field>
              <Field id="schedule-budget" label="Cost budget (USD)" error={errors.costBudgetUSD}>
                <input id="schedule-budget" className={`${input} ${border(errors.costBudgetUSD)}`} value={form.costBudgetUSD} inputMode="decimal"
                  onChange={(e) => set('costBudgetUSD', e.target.value)} />
              </Field>
            </>
          )}

          <Field id="schedule-cron" label="Cron" error={errors.cron} hint="minute hour day-of-month month day-of-week, or @daily, @every 1h…">
            <input id="schedule-cron" className={`${input} ${border(errors.cron)} font-mono`} value={form.cron}
              onChange={(e) => set('cron', e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-1.5" aria-label="Cron presets">
            {CRON_PRESETS.map((p) => (
              <button key={p.cron} type="button" onClick={() => set('cron', p.cron)}
                className={`rounded-full border px-2 py-0.5 text-xs ${form.cron === p.cron ? 'border-roundtable-gold/60 text-roundtable-gold' : 'border-roundtable-steel text-gray-400 hover:text-white'}`}>
                {p.label}
              </button>
            ))}
          </div>

          <Field id="schedule-timezone" label="Time zone" error={errors.timeZone}>
            <input id="schedule-timezone" list="schedule-timezones" className={`${input} ${border(errors.timeZone)}`} value={form.timeZone} placeholder="UTC"
              onChange={(e) => set('timeZone', e.target.value)} />
            <datalist id="schedule-timezones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </Field>

          <NextRunsPreview cron={form.cron} timeZone={form.timeZone} now={now} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="schedule-concurrency" label="Concurrency policy" error={errors.concurrency}
              hint="When a run is still active: Allow another, Forbid (skip) or Replace it.">
              <select id="schedule-concurrency" className={`${input} ${border(errors.concurrency)}`} value={form.concurrency}
                onChange={(e) => set('concurrency', e.target.value as ConcurrencyPolicy)}>
                <option value="Allow">Allow</option>
                <option value="Forbid">Forbid</option>
                {form.kind === 'chain' && <option value="Replace">Replace</option>}
              </select>
            </Field>
            <Field id="schedule-suspend" label="State" error={errors.suspend}>
              <label className="flex items-center gap-2 py-2 text-sm text-gray-200">
                <input id="schedule-suspend" type="checkbox" checked={form.suspend} onChange={(e) => set('suspend', e.target.checked)} />
                Suspended (spec.suspend)
              </label>
            </Field>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Link to="/schedules" className={btnGray}>Cancel</Link>
            <button type="submit" className={btnGold} disabled={saving}>
              <Save className="w-4 h-4" aria-hidden /> {saving ? 'Saving…' : editing ? 'Save changes' : 'Create schedule'}
            </button>
          </div>
        </form>

        <section aria-label="YAML preview" className="lg:sticky lg:top-4 self-start bg-roundtable-slate border border-roundtable-steel rounded-xl">
          <div className="flex items-center justify-between border-b border-roundtable-steel px-4 py-2">
            <h2 className="text-sm font-medium text-white">YAML</h2>
            <button type="button" className={btnGray} onClick={() => void copy()} disabled={!yaml}>
              {copied ? <Check className="w-4 h-4" aria-hidden /> : <Copy className="w-4 h-4" aria-hidden />} {copied ? 'Copied' : 'Copy YAML'}
            </button>
          </div>
          <pre data-testid="schedule-yaml" className="max-h-[70vh] overflow-auto p-4 text-xs text-gray-200 font-mono whitespace-pre">{yaml}</pre>
          <p className="border-t border-roundtable-steel px-4 py-2 text-xs text-gray-500">
            {editing
              ? <>The gateway's manifest after saving; it updates the <code>{CALLER_ANNOTATION}</code> annotation to the dashboard.</>
              : <>Commit it to Git, or save it: the gateway then adds the label <code>{GATEWAY_LABEL}: {GATEWAY_LABEL_VALUE}</code> and the <code>{CALLER_ANNOTATION}</code> annotation.</>}
          </p>
        </section>
      </div>
    </div>
  )
}
