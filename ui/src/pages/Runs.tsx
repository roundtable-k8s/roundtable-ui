import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Workflow, ExternalLink } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useUrlParam } from '../hooks/useUrlParam'
import { PageHeader, RefreshButton, ListState, PhaseBadge } from '../components/ui'
import { TraceLink } from '../components/TraceLink'
import { UntrustedText } from '../components/UntrustedText'
import { sanitizeText } from '../lib/untrusted'
import {
  RUN_PHASES, RUN_SOURCES, ageLabel, issueUrl, runRows, runsUrl,
  type GatewayRun,
} from '../lib/runs'

const POLL_MS = 10_000
const SOURCE_OPTIONS = ['all', ...RUN_SOURCES] as const

const SOURCE_STYLES: Record<string, string> = {
  gateway: 'bg-blue-500/10 text-blue-300 border-blue-500/30',
  trigger: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
  pickup: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
}

function SourceBadge({ source }: { source?: string }) {
  if (!source) return <span className="text-gray-600">—</span>
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${SOURCE_STYLES[source] ?? 'bg-gray-500/10 text-gray-300 border-gray-500/30'}`}>
      {sanitizeText(source)}
    </span>
  )
}

function IssueCell({ run }: { run: GatewayRun }) {
  if (!run.issue) return <span className="text-gray-600">—</span>
  const label = `${sanitizeText(run.issue.repo)}#${run.issue.number}`
  const href = issueUrl(run.issue)
  if (!href) return <span className="text-gray-300">{label}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-roundtable-gold hover:underline">
      {label} <ExternalLink className="w-3 h-3" aria-hidden />
    </a>
  )
}

/** Running runs show how long they have been running; others show their age. */
function runAge(run: GatewayRun): string {
  if (run.phase === 'Running' && run.runningSeconds != null) return `running ${ageLabel(run.runningSeconds)}`
  return ageLabel(run.ageSeconds)
}

export function RunsTable({ runs }: { runs: GatewayRun[] }) {
  return (
    <div className="overflow-x-auto bg-roundtable-slate border border-roundtable-steel rounded-xl">
      <table aria-label="Runs" className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-roundtable-steel">
            <th className="px-4 py-2">Chain</th>
            <th className="px-4 py-2">Phase</th>
            <th className="px-4 py-2">Source</th>
            <th className="px-4 py-2">Age</th>
            <th className="px-4 py-2">Issue</th>
            <th className="px-4 py-2">Trace</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={`${r.namespace ?? ''}/${r.run}`} className="border-b border-roundtable-steel/50 last:border-0">
              <td className="px-4 py-2">
                {r.chain
                  ? <Link to={`/chains?chain=${encodeURIComponent(r.chain)}`} className="text-roundtable-gold hover:underline">{sanitizeText(r.chain)}</Link>
                  : <span className="text-gray-600">—</span>}
                <UntrustedText text={r.run} as="div" className="text-xs text-gray-500 font-mono" />
              </td>
              <td className="px-4 py-2">{r.phase ? <PhaseBadge phase={sanitizeText(r.phase)} /> : <span className="text-gray-600">—</span>}</td>
              <td className="px-4 py-2"><SourceBadge source={r.source} /></td>
              <td className="px-4 py-2 tabular-nums text-gray-300 whitespace-nowrap">{runAge(r)}</td>
              <td className="px-4 py-2"><IssueCell run={r} /></td>
              <td className="px-4 py-2"><TraceLink traceId={r.traceId} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RunsPage() {
  const [source, setSource] = useUrlParam('source', 'all', SOURCE_OPTIONS)
  const [phase, setPhase] = useUrlParam('phase', '', RUN_PHASES)
  const [activeParam, setActive] = useUrlParam('active', '', ['true'])
  const active = activeParam === 'true'

  const { data, loading, error, updatedAt, refresh } = usePolledFetch<unknown>(runsUrl(source, active), POLL_MS, { runs: [] })
  const all = useMemo(() => runRows(data), [data])
  const rows = useMemo(() => (phase ? all.filter((r) => r.phase === phase) : all), [all, phase])

  const selectClass = 'bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-1.5 text-sm text-gray-200'
  return (
    <div>
      <PageHeader icon={Workflow} title="Runs" subtitle="Chain runs of every source: gateway, trigger and pickup">
        <RefreshButton onClick={refresh} loading={loading} updatedAt={updatedAt} />
      </PageHeader>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <label className="text-sm text-gray-400 flex items-center gap-2">
          Source
          <select aria-label="Source" className={selectClass} value={source} onChange={(e) => setSource(e.target.value)}>
            {SOURCE_OPTIONS.map((s) => <option key={s} value={s}>{s === 'all' ? 'All sources' : s}</option>)}
          </select>
        </label>
        <label className="text-sm text-gray-400 flex items-center gap-2">
          Phase
          <select aria-label="Phase" className={selectClass} value={phase} onChange={(e) => setPhase(e.target.value)}>
            <option value="">All phases</option>
            {RUN_PHASES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-sm text-gray-400 flex items-center gap-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked ? 'true' : '')} />
          Active only
        </label>
      </div>

      <ListState
        loading={loading}
        error={error}
        count={rows.length}
        what="runs"
        emptyTitle="No runs"
        emptySub="No chain runs match these filters."
        icon={Workflow}
        onRetry={refresh}
      >
        <RunsTable runs={rows} />
      </ListState>
    </div>
  )
}
