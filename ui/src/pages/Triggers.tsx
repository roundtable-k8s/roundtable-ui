import { Link, useParams } from 'react-router-dom'
import { Zap, ArrowLeft, ExternalLink, CalendarClock } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useTableFilter } from '../hooks/useTableFilter'
import { withTable } from '../lib/tables'
import { PageHeader, RefreshButton, ErrorBanner, Spinner, ListState, TableBadge } from '../components/ui'
import { countLabel, formatRelativeTime, until } from '../lib/format'
import { chainLink, TRIGGER_DOCS_URL, type Trigger } from '../lib/triggers'

const POLL_MS = 10000

function ReadyBadge({ t }: { t: Trigger }) {
  if (t.suspended) {
    return <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">Suspended</span>
  }
  const cls = t.ready === 'true' ? 'border-green-500/30 bg-green-500/10 text-green-300'
    : t.ready === 'false' ? 'border-red-500/30 bg-red-500/10 text-red-300'
    : 'border-gray-500/30 bg-gray-500/10 text-gray-300'
  const label = t.ready === 'true' ? 'Ready' : t.ready === 'false' ? 'Not ready' : 'Unknown'
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${cls}`}>{label}</span>
}

function TargetCell({ t }: { t: Trigger }) {
  if (t.targetKind === 'knight') {
    return <Link to={`/fleet?knight=${encodeURIComponent(t.targetKnight ?? '')}`} className="text-roundtable-gold hover:underline">knight {t.targetKnight}</Link>
  }
  if (t.targetKind === 'mission') {
    return <Link to="/missions" className="text-roundtable-gold hover:underline">mission</Link>
  }
  return <Link to={chainLink(t.targetChain)} className="text-roundtable-gold hover:underline">{t.targetChain}</Link>
}

function RunRef({ run, kind }: { run: string; kind?: Trigger['targetKind'] }) {
  if (kind === 'knight' || kind === 'mission') return <span className="font-mono text-gray-200">{run}</span>
  return <Link to={chainLink(run)} className="font-mono text-roundtable-gold hover:underline">{run}</Link>
}

function when(iso?: string): string {
  return iso ? formatRelativeTime(iso) : '—'
}

function TriggersEmptyExtra() {
  return (
    <div>
      <p className="text-center text-sm">
        <a href={TRIGGER_DOCS_URL} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-roundtable-gold hover:underline">
          Read the docs <ExternalLink className="w-3 h-3" aria-hidden />
        </a>
      </p>
    </div>
  )
}

export function TriggersTable({ triggers, showTable = false }: { triggers: Trigger[]; showTable?: boolean }) {
  return (
    <div className="overflow-x-auto bg-roundtable-slate border border-roundtable-steel rounded-xl">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-roundtable-steel">
            <th className="px-4 py-3 font-medium">Trigger</th>
            <th className="px-4 py-3 font-medium">Source</th>
            <th className="px-4 py-3 font-medium">Target</th>
            <th className="px-4 py-3 font-medium">Last fired</th>
            <th className="px-4 py-3 font-medium">Next scheduled</th>
            <th className="px-4 py-3 font-medium text-right">Active runs</th>
            <th className="px-4 py-3 font-medium">State</th>
          </tr>
        </thead>
        <tbody>
          {triggers.map(t => (
            <tr key={`${t.namespace}/${t.name}`} className="border-b border-roundtable-steel/50 last:border-0">
              <td className="px-4 py-3">
                <Link to={`/triggers/${t.namespace}/${t.name}`} className="text-roundtable-gold hover:underline font-medium">{t.name}</Link>
                {showTable && <span className="ml-2"><TableBadge table={t.table} /></span>}
              </td>
              <td className="px-4 py-3">
                <span className="rounded bg-roundtable-steel/50 px-1.5 py-0.5 text-xs text-gray-300 mr-2">{t.source.type}</span>
                <span className="font-mono text-xs text-gray-400">{t.source.detail}</span>
              </td>
              <td className="px-4 py-3">
                <TargetCell t={t} />
              </td>
              <td className="px-4 py-3 text-gray-300">{when(t.lastFiredAt)}</td>
              <td className="px-4 py-3 text-gray-300">{until(t.nextScheduledAt)}</td>
              <td className="px-4 py-3 text-right text-gray-200">{t.activeRuns.length}</td>
              <td className="px-4 py-3"><ReadyBadge t={t} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function TriggersPage() {
  const { table } = useTableFilter()
  const { data, loading, error, updatedAt, refresh } = usePolledFetch<Trigger[]>(withTable('/api/triggers', table), POLL_MS, [])
  return (
    <div>
      <PageHeader icon={Zap} title="Triggers" subtitle={[!loading && !(error && data.length === 0) && countLabel(data.length, data.length, 'triggers'), 'What starts your chains: schedules, NATS subjects and webhooks'].filter(Boolean).join(' · ')}>
        <Link to="/schedules" className="inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
          <CalendarClock className="w-4 h-4" aria-hidden /> Schedules
        </Link>
        <RefreshButton onClick={refresh} loading={loading} updatedAt={updatedAt} />
      </PageHeader>
      <ListState loading={loading} error={error} count={data.length} what="triggers" icon={Zap} onRetry={refresh}
        emptyTitle="No Triggers yet"
        emptySub="A Trigger starts a Chain automatically: on a cron schedule, when a NATS message arrives, or on a webhook call."
        emptyExtra={<TriggersEmptyExtra />}>
        <TriggersTable triggers={data} showTable={!table} />
      </ListState>
    </div>
  )
}

export function TriggerDetail({ trigger: t }: { trigger: Trigger }) {
  return (
    <div className="space-y-6">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm bg-roundtable-slate border border-roundtable-steel rounded-xl p-4">
        <dt className="text-gray-400">Source</dt>
        <dd className="text-gray-200"><span className="font-mono">{t.source.detail}</span> <span className="text-gray-500">({t.source.type})</span></dd>
        <dt className="text-gray-400">Target</dt>
        <dd><TargetCell t={t} /></dd>
        <dt className="text-gray-400">Concurrency</dt>
        <dd className="text-gray-200">{t.concurrencyPolicy}{t.maxActive ? ` (max ${t.maxActive} active)` : ''}</dd>
        <dt className="text-gray-400">State</dt>
        <dd><ReadyBadge t={t} /></dd>
        <dt className="text-gray-400">Last fired</dt>
        <dd className="text-gray-200">{when(t.lastFiredAt)}</dd>
        <dt className="text-gray-400">Next scheduled</dt>
        <dd className="text-gray-200">{until(t.nextScheduledAt)}</dd>
      </dl>

      <section aria-label="active runs">
        <h2 className="text-lg font-semibold text-white mb-2">Active runs ({t.activeRuns.length})</h2>
        {t.activeRuns.length === 0 ? <p className="text-sm text-gray-500">No runs in flight.</p> : (
          <ul className="text-sm space-y-1">
            {t.activeRuns.map(r => (
              <li key={r}><RunRef run={r} kind={t.targetKind} /></li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="recent firings">
        <h2 className="text-lg font-semibold text-white mb-2">Recent firings</h2>
        {t.recentFirings.length === 0 ? <p className="text-sm text-gray-500">This trigger has not fired yet.</p> : (
          <div className="overflow-x-auto bg-roundtable-slate border border-roundtable-steel rounded-xl">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-roundtable-steel">
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-4 py-2 font-medium">Key</th>
                  <th className="px-4 py-2 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {t.recentFirings.map((f, i) => (
                  <tr key={`${f.time}-${i}`} className="border-b border-roundtable-steel/50 last:border-0">
                    <td className="px-4 py-2 text-gray-300" title={f.time}>{formatRelativeTime(f.time)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-400">{f.key || '—'}</td>
                    <td className="px-4 py-2">
                      {f.skipReason
                        ? <span className="text-amber-300">Skipped: {f.skipReason}</span>
                        : f.run
                          ? <RunRef run={f.run} kind={t.targetKind} />
                          : <span className="text-gray-500">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {t.conditions.length > 0 && (
        <section aria-label="conditions">
          <h2 className="text-lg font-semibold text-white mb-2">Conditions</h2>
          <ul className="text-sm space-y-1 text-gray-300">
            {t.conditions.map(c => (
              <li key={c.type}>{c.type}: {c.status}{c.reason ? ` (${c.reason})` : ''}{c.message ? ` — ${c.message}` : ''}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

export function TriggerDetailPage() {
  const { namespace = '', name = '' } = useParams()
  const url = `/api/triggers/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
  const { data, loading, error, refresh } = usePolledFetch<Trigger | null>(url, POLL_MS, null)
  return (
    <div>
      <PageHeader icon={Zap} title={name} subtitle="Trigger">
        <RefreshButton onClick={refresh} loading={loading} />
      </PageHeader>
      <Link to="/triggers" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
        <ArrowLeft className="w-4 h-4" aria-hidden /> All triggers
      </Link>
      {error && <div className="mb-4"><ErrorBanner>Failed to load trigger: {error}</ErrorBanner></div>}
      {loading && !data && !error && <div className="flex justify-center py-12"><Spinner /></div>}
      {data && <TriggerDetail trigger={data} />}
    </div>
  )
}
