import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Moon } from 'lucide-react'
import { apiGet, apiGetWithTotal } from '../lib/api'
import { PageHeader, RefreshButton, StatCard, ErrorBanner, Spinner, Badge } from '../components/ui'
import { useTableFilter } from '../hooks/useTableFilter'
import { inTable, withTable } from '../lib/tables'
import { useUrlParam } from '../hooks/useUrlParam'
import { CHAIN_LIST_LIMIT, truncationNote } from '../lib/chainTotal'
import { DEAD_LETTERS_URL, deadLetterTime, errorExcerpt, type DeadLetter } from '../lib/deadLetters'
import { NOTIONAL_HINT } from '../lib/cost'
import { formatCost, formatTimestampOrDate } from '../lib/format'
import { DEFAULT_SINCE, SINCE_PRESETS, resolveSince, summarise } from '../lib/overnight'
import { outcomeTone, outcomeLabel, scheduleLink, type Schedule } from '../lib/schedules'
import { sanitizeText } from '../lib/untrusted'
import type { Chain } from '../lib/types'
import { DEAD_LETTER_CAP } from '../hooks/useOpenDeadLetters'

const CHAINS_URL = `/api/chains?copies=include&limit=${CHAIN_LIST_LIMIT}`

interface Panel<T> { data: T | null; error: string | null }

const errMsg = (e: unknown, what: string) => (e instanceof Error ? e.message : `Failed to load ${what}`)

/** datetime-local value (local time, no zone) for an epoch ms. */
function toLocalInput(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function OvernightPage() {
  const [since, setSince] = useUrlParam('since', DEFAULT_SINCE)
  const { table } = useTableFilter()
  const [chains, setChains] = useState<Panel<Chain[]> & { total: number | null }>({ data: null, error: null, total: null })
  const [dead, setDead] = useState<Panel<DeadLetter[]>>({ data: null, error: null })
  const [schedules, setSchedules] = useState<Panel<Schedule[]>>({ data: null, error: null })
  const [loading, setLoading] = useState(true)
  const [loadedAt, setLoadedAt] = useState(() => Date.now())

  const load = useCallback(async () => {
    setLoading(true)
    await Promise.all([
      apiGetWithTotal<Chain[]>(withTable(CHAINS_URL, table)).then(({ items, total }) => {
        setChains({ data: items ?? [], error: null, total })
      }, (e) => setChains((p) => ({ ...p, error: errMsg(e, 'chains') }))),
      apiGet<{ deadLetters?: DeadLetter[] }>(DEAD_LETTERS_URL).then(
        (d) => setDead({ data: (d.deadLetters ?? []).filter((x) => inTable(table, x.table)), error: null }),
        (e) => setDead((p) => ({ ...p, error: errMsg(e, 'dead letters') })),
      ),
      apiGet<{ schedules?: Schedule[] }>(withTable('/api/schedules', table)).then(
        (d) => setSchedules({ data: d.schedules ?? [], error: null }),
        (e) => setSchedules((p) => ({ ...p, error: errMsg(e, 'schedules') })),
      ),
    ])
    setLoadedAt(Date.now())
    setLoading(false)
  }, [table])
  useEffect(() => { load() }, [load])

  const sinceMs = useMemo(() => resolveSince(since, loadedAt), [since, loadedAt])
  const isPreset = SINCE_PRESETS.some((p) => p.value === since)
  const s = useMemo(
    () => summarise({ chains: chains.data ?? [], deadLetters: dead.data ?? [], schedules: schedules.data ?? [] }, sinceMs),
    [chains.data, dead.data, schedules.data, sinceMs],
  )

  const chainCut = truncationNote(chains.data?.length ?? 0, chains.total)
  const deadCut = (dead.data?.length ?? 0) >= DEAD_LETTER_CAP
    ? `showing the newest ${DEAD_LETTER_CAP} (the list is capped, there may be more)` : null
  const dash = (v: number | string, data: unknown) => (data === null ? '—' : v)

  return (
    <div>
      <PageHeader icon={Moon} title="Overnight">
        <RefreshButton onClick={load} loading={loading} />
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="ov-since" className="text-sm text-gray-400 mb-1 block">Since</label>
          <select id="ov-since" value={isPreset ? since : 'custom'}
            onChange={(e) => setSince(e.target.value === 'custom' ? toLocalInput(sinceMs) : e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white">
            {SINCE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            <option value="custom">Custom time…</option>
          </select>
        </div>
        <div>
          <label htmlFor="ov-since-time" className="text-sm text-gray-400 mb-1 block">From</label>
          <input id="ov-since-time" type="datetime-local" value={toLocalInput(sinceMs)}
            onChange={(e) => e.target.value && setSince(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white" />
        </div>
      </div>

      {loading && !chains.data && !dead.data && !schedules.data && <Spinner />}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Runs finished" value={dash(s.finished, chains.data)} />
        <StatCard label="Succeeded" value={dash(s.succeeded, chains.data)} color="text-green-400" />
        <StatCard label="Failed" value={dash(s.failed, chains.data)} color="text-red-400" />
        <StatCard label="Cost" value={dash(formatCost(s.spendUSD), chains.data)}
          detail={chains.data && s.notionalCostUSD > 0 ? `+ ${formatCost(s.notionalCostUSD)} notional` : undefined} />
      </div>
      {s.notionalCostUSD > 0 && <p className="mb-4 text-xs text-gray-500">{NOTIONAL_HINT}</p>}

      <section aria-label="Failed runs" className="mb-6">
        <h2 className="text-lg font-semibold text-white mb-2">Failed runs {chains.data && <span className="text-gray-500 text-sm">({s.failedRuns.length})</span>}</h2>
        {chains.error && <ErrorBanner>Chains: {chains.error}</ErrorBanner>}
        {chainCut && <p data-testid="chains-cut" className="text-sm text-yellow-400 mb-2">Chains: {chainCut}; older runs may be missing.</p>}
        {chains.data && s.failedRuns.length === 0 && <p className="text-sm text-gray-500">No failed runs in this window.</p>}
        <ul className="space-y-1">
          {s.failedRuns.map((c) => (
            <li key={`${c.namespace}/${c.name}`} className="text-sm">
              <Link to={`/chains?chain=${encodeURIComponent(c.name)}`} className="text-roundtable-gold hover:underline">{c.name}</Link>
              <span className="text-gray-400"> · {c.phase}{c.completionTime ? ` · ${formatTimestampOrDate(c.completionTime)}` : ''}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Open dead letters" className="mb-6">
        <h2 className="text-lg font-semibold text-white mb-2">Open dead letters {dead.data && <span className="text-gray-500 text-sm">({s.openDeadLetters.length})</span>}</h2>
        {dead.error && <ErrorBanner>Dead letters: {dead.error}</ErrorBanner>}
        {deadCut && <p data-testid="dead-cut" className="text-sm text-yellow-400 mb-2">Dead letters: {deadCut}.</p>}
        {dead.data && s.openDeadLetters.length === 0 && <p className="text-sm text-gray-500">No open dead letters in this window.</p>}
        <ul className="space-y-1">
          {s.openDeadLetters.map((d) => (
            <li key={d.taskId} className="text-sm">
              <Link to="/failed" className="text-roundtable-gold hover:underline">{sanitizeText(d.knight)}</Link>
              <span className="text-gray-400"> · {sanitizeText(d.reason)} · {formatTimestampOrDate(deadLetterTime(d))}
                {d.error ? ` · ${sanitizeText(errorExcerpt(d.error))}` : ''}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Schedule firings" className="mb-6">
        <h2 className="text-lg font-semibold text-white mb-2">
          Schedule firings {schedules.data && <span className="text-gray-500 text-sm">({s.firedSchedules.length}, {s.failedSchedules.length} not succeeded)</span>}
        </h2>
        {schedules.error && <ErrorBanner>Schedules: {schedules.error}</ErrorBanner>}
        {schedules.data && s.firedSchedules.length === 0 && <p className="text-sm text-gray-500">No schedule fired in this window.</p>}
        <ul className="space-y-1">
          {s.firedSchedules.map((x) => {
            const outcome = x.lastResult?.outcome ?? 'unknown'
            return (
              <li key={`${x.namespace}/${x.name}`} className="text-sm">
                <Link to={scheduleLink(x.namespace, x.name)} className="text-roundtable-gold hover:underline">{x.name}</Link>
                <Badge tone={outcomeTone(outcome)} className="ml-2">{outcomeLabel(outcome)}</Badge>
                <span className="text-gray-400">{x.lastRunAt ? ` · ${formatTimestampOrDate(x.lastRunAt)}` : ''}</span>
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
