import { Link, useParams } from 'react-router-dom'
import { Target, ArrowLeft } from 'lucide-react'
import { useMission } from '../hooks/useMission'
import type { Mission } from '../hooks/useMissions'
import { MissionPhaseBadge } from '../components/MissionPhaseBadge'
import { MissionResults, KnightStatusList, ChainStatusList } from '../components/MissionSections'
import { TraceLink } from '../components/TraceLink'
import { CostTag } from '../components/CostTag'
import { PageHeader, RefreshButton, ErrorBanner, Spinner, EmptyState, TableBadge } from '../components/ui'
import { getKnightConfig } from '../lib/knights'
import { formatCost, formatDateTime } from '../lib/format'
import { tokensText } from '../lib/cost'

const sectionCls = 'mb-4 rounded-xl border border-roundtable-steel bg-roundtable-slate p-4'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title.toLowerCase()} className={sectionCls}>
      <h2 className="mb-3 text-lg font-semibold text-white">{title}</h2>
      {children}
    </section>
  )
}

function Timing({ label, ts }: { label: string; ts?: string | null }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-white">{ts ? formatDateTime(ts) : '—'}</dd>
    </div>
  )
}

function MissionBody({ m }: { m: Mission }) {
  const knights = m.knights ?? []
  const chainStatuses = m.chainStatuses ?? []
  const chains = m.chains ?? []
  const knightStatuses = m.knightStatuses ?? []
  const knightCosts = m.knightCosts ?? []
  // Why: only conditions that are not True explain a stuck or failed mission
  const why = (m.conditions ?? []).filter(c => c.status !== 'True')
  const budget = parseFloat(m.costBudgetUSD) || 0
  const cost = parseFloat(m.totalCost) || 0
  const finished = m.phase === 'Succeeded' || m.phase === 'Failed' || m.phase === 'Expired' ||
    (m.phase === 'CleaningUp' && !!m.completedAt)

  return (
    <>
      <Section title="Objective">
        <p className="whitespace-pre-wrap break-words text-sm text-gray-200">{m.objective}</p>
      </Section>

      <Section title="Timing">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Timing label="Created" ts={m.createdAt} />
          <Timing label="Started" ts={m.startedAt} />
          <Timing label="Completed" ts={m.completedAt} />
          <Timing label="Expires" ts={m.expiresAt} />
        </dl>
      </Section>

      {why.length > 0 && (
        <Section title="Why">
          <ul className="space-y-2 text-sm">
            {why.map(c => (
              <li key={c.type} className="break-words rounded-lg border border-amber-500/30 bg-amber-500/10 p-2">
                <span className="font-medium text-amber-300">{c.type}</span>
                {c.reason && <span className="text-gray-300"> · {c.reason}</span>}
                {c.message && <p className="text-gray-400">{c.message}</p>}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Knights">
        {knightStatuses.length > 0 ? <KnightStatusList statuses={knightStatuses} />
          : knights.length > 0 ? (
            <ul className="flex flex-wrap gap-2 text-sm text-white">
              {knights.map(k => <li key={k} className="rounded bg-roundtable-navy/50 px-2 py-1">{getKnightConfig(k).emoji} {k}</li>)}
            </ul>
          ) : <p className="text-sm text-gray-500">No knights assigned yet.</p>}
      </Section>

      <Section title="Chains">
        {chainStatuses.length > 0
          ? <ChainStatusList statuses={chainStatuses} chainHref={c => `/chains?chain=${encodeURIComponent(c.chainCRName)}`} />
          : chains.length > 0 ? (
            <ul className="space-y-1 text-sm text-white">{chains.map(c => <li key={c}>{c}</li>)}</ul>
          ) : <p className="text-sm text-gray-500">No chains yet.</p>}
      </Section>

      <Section title="Cost">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <div><dt className="text-gray-500">Total</dt><dd><CostTag costUSD={m.totalCost} notionalUSD={m.notionalCostUSD} className="text-white" /></dd></div>
          <div><dt className="text-gray-500">Budget</dt><dd className="text-white">{budget > 0 ? `${formatCost(cost)} / ${formatCost(budget)}` : 'none'}</dd></div>
          <div><dt className="text-gray-500">Tokens</dt><dd className="text-white">{tokensText(m.tokens)}</dd></div>
        </dl>
        {knightCosts.length > 0 && (
          <ul aria-label="cost per knight" className="mt-3 space-y-1 text-sm">
            {knightCosts.map(k => (
              <li key={k.name} className="flex items-center justify-between gap-3 rounded bg-roundtable-navy/50 px-2 py-1">
                <span className="text-white">{k.name}</span>
                <span className="text-right text-gray-300"><CostTag costUSD={k.costUSD} notionalUSD={k.notionalCostUSD} /> · {tokensText(k.tokens)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {m.successCriteria && (
        <Section title="Success criteria">
          <p className="whitespace-pre-wrap break-words text-sm text-gray-300">{m.successCriteria}</p>
        </Section>
      )}

      {m.briefing && (
        <Section title="Briefing">
          <p className="whitespace-pre-wrap break-words text-sm text-gray-300">{m.briefing}</p>
        </Section>
      )}

      {(finished || m.result) && (
        <Section title="Results">
          {m.result && <pre className="mb-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-roundtable-gold/20 bg-roundtable-navy p-3 text-xs text-gray-300">{m.result}</pre>}
          {finished && <MissionResults name={m.name} />}
        </Section>
      )}

      {m.traceId && <div className="text-sm"><TraceLink traceId={m.traceId} /></div>}
    </>
  )
}

export function MissionDetailPage() {
  const { name = '' } = useParams()
  const { mission, loading, error, notFound, refresh } = useMission(name)

  return (
    <div className="min-w-0">
      <PageHeader icon={Target} title={name} subtitle="Mission">
        <RefreshButton onClick={refresh} loading={loading} />
      </PageHeader>
      <Link to="/missions" className="mb-4 inline-flex items-center gap-1 text-sm text-gray-400 hover:text-white">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All missions
      </Link>
      {notFound && (
        <div>
          <EmptyState icon={Target} title="Mission not found" sub={`No mission named ${name}.`} />
          <p className="text-center"><Link to="/missions" className="text-roundtable-gold hover:underline">Back to missions</Link></p>
        </div>
      )}
      {error && <div className="mb-4"><ErrorBanner>Failed to load mission: {error}</ErrorBanner></div>}
      {loading && !mission && !error && !notFound && <div className="flex justify-center py-12"><Spinner /></div>}
      {mission && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <MissionPhaseBadge phase={mission.phase} />
            <TableBadge table={mission.table} />
          </div>
          <MissionBody m={mission} />
        </>
      )}
    </div>
  )
}
