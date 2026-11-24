import { useEffect, useState } from 'react'
import { Inbox, AlertTriangle, Clock, ExternalLink, Gauge } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { apiGet } from '../lib/api'
import {
  type KnightQueue, type QueueHistory, type QueueWarning,
  QUEUE_POLL_MS, OLDEST_WAIT_WARN_SECONDS,
  appendSamples, formatWait, grafanaKnightUrl, oldestWait, queueWarnings,
} from '../lib/queues'
import { QueueSparkline, PENDING_COLOR, REPLICAS_COLOR } from '../components/QueueSparkline'
import { PageHeader, RefreshButton, StatCard, ErrorBanner, Spinner, EmptyState } from '../components/ui'

// Browser-side history survives navigating away and back (cleared on reload).
let sessionHistory: QueueHistory = {}

/** Re-render every `ms` so wait times keep growing between polls. */
function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export function QueuesPage() {
  const { data: queues, loading, error, refresh } = usePolledFetch<KnightQueue[]>('/api/queues', QUEUE_POLL_MS, [])
  const [history, setHistory] = useState<QueueHistory>(sessionHistory)
  const [grafanaUrl, setGrafanaUrl] = useState<string | undefined>()
  const now = useNow()

  useEffect(() => {
    if (!queues.length) return
    sessionHistory = appendSamples(sessionHistory, queues, Date.now())
    setHistory(sessionHistory)
  }, [queues])

  useEffect(() => {
    apiGet<{ grafanaQueuesUrl?: string }>('/api/config')
      .then(c => setGrafanaUrl(c.grafanaQueuesUrl))
      .catch(() => { /* no Grafana link */ })
  }, [])

  const grafana = grafanaKnightUrl(grafanaUrl)
  const totalPending = queues.reduce((n, q) => n + (q.pending || 0), 0)
  const totalInFlight = queues.reduce((n, q) => n + (q.ackPending || 0), 0)
  const warned = queues.filter(q => queueWarnings(q, now).length > 0).length
  const longest = queues.reduce((m, q) => Math.max(m, oldestWait(q, now)), 0)

  return (
    <div>
      <PageHeader icon={Inbox} title="Queues" subtitle="JetStream backlog and scaling per knight">
        {grafana && (
          <a
            href={grafana}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg border border-roundtable-steel text-gray-300 hover:text-roundtable-gold"
          >
            <ExternalLink className="w-4 h-4" /> Grafana history
          </a>
        )}
        <RefreshButton onClick={refresh} loading={loading} />
      </PageHeader>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Pending" value={totalPending} icon={<Inbox className="w-4 h-4" />} />
        <StatCard label="In flight" value={totalInFlight} icon={<Gauge className="w-4 h-4" />} />
        <StatCard label="Longest wait" value={formatWait(longest)} icon={<Clock className="w-4 h-4" />} />
        <StatCard
          label="Knights with warnings"
          value={warned}
          total={queues.length}
          color={warned ? 'text-amber-400' : 'text-white'}
          icon={<AlertTriangle className="w-4 h-4" />}
        />
      </div>

      {error && <div className="mb-4"><ErrorBanner>Failed to load queues: {error}</ErrorBanner></div>}

      {loading && !queues.length ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : !queues.length ? (
        !error && <EmptyState icon={Inbox} title="No knight queues" sub="No knights found in this namespace." />
      ) : (
        <QueuesTable queues={queues} history={history} now={now} grafanaUrl={grafanaUrl} />
      )}
    </div>
  )
}

export function QueuesTable({ queues, history, now, grafanaUrl }: {
  queues: KnightQueue[]
  history: QueueHistory
  now: number
  grafanaUrl?: string
}) {
  return (
    <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl overflow-x-auto">
      <div className="flex flex-wrap items-center gap-4 px-4 pt-3 text-xs text-gray-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 h-0.5" style={{ background: PENDING_COLOR }} /> pending
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-4 border-t-2 border-dashed" style={{ borderColor: REPLICAS_COLOR }} /> replicas
        </span>
        <span>▲▼ scale event</span>
        <span className="text-gray-500">Oldest-wait badge at {formatWait(OLDEST_WAIT_WARN_SECONDS)}</span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-400 border-b border-roundtable-steel">
            <th className="px-4 py-3 font-medium">Knight</th>
            <th className="px-3 py-3 font-medium text-right">Pending</th>
            <th className="px-3 py-3 font-medium text-right">Ack-pending</th>
            <th className="px-3 py-3 font-medium text-right">Redelivered</th>
            <th className="px-3 py-3 font-medium text-right">Oldest wait</th>
            <th className="px-3 py-3 font-medium text-right">Free slots</th>
            <th className="px-3 py-3 font-medium text-right" title="ready / current / max">Replicas</th>
            <th className="px-3 py-3 font-medium">History</th>
            <th className="px-4 py-3 font-medium">Warnings</th>
          </tr>
        </thead>
        <tbody>
          {queues.map(q => (
            <QueueRow key={q.knight} q={q} samples={history[q.knight] ?? []} now={now} grafanaUrl={grafanaUrl} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function QueueRow({ q, samples, now, grafanaUrl }: {
  q: KnightQueue
  samples: QueueHistory[string]
  now: number
  grafanaUrl?: string
}) {
  const warnings = queueWarnings(q, now)
  const link = grafanaKnightUrl(grafanaUrl, q.knight)
  const muted = !q.consumerFound || !!q.error
  const num = (v: number) => (muted ? '—' : v)

  return (
    <tr data-testid={`queue-row-${q.knight}`} className="border-b border-roundtable-steel/50 last:border-0">
      <td className="px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-white capitalize">{q.knight}</span>
          {link && (
            <a href={link} target="_blank" rel="noopener noreferrer" title="Grafana history" aria-label={`Grafana history for ${q.knight}`} className="text-gray-500 hover:text-roundtable-gold">
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
        {!q.consumerFound && !q.error && <div className="text-xs text-gray-500">no consumer yet</div>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-white">{num(q.pending)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-300">{num(q.ackPending)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-300">{num(q.redelivered)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-300">{muted ? '—' : formatWait(oldestWait(q, now))}</td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-300">{num(q.freeSlots)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-gray-300 whitespace-nowrap">
        {q.readyReplicas}/{q.replicas}/{q.maxReplicas ?? '—'}
      </td>
      <td className="px-3 py-2"><QueueSparkline samples={samples} /></td>
      <td className="px-4 py-2">
        <div className="flex flex-wrap gap-1">
          {warnings.map(w => <WarningBadge key={w.kind} w={w} />)}
        </div>
      </td>
    </tr>
  )
}

const badgeStyle: Record<QueueWarning['kind'], string> = {
  'oldest-wait': 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  saturated: 'bg-red-500/10 text-red-400 border-red-500/30',
  error: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
}

function WarningBadge({ w }: { w: QueueWarning }) {
  const Icon = w.kind === 'oldest-wait' ? Clock : AlertTriangle
  return (
    <span
      title={w.detail}
      data-testid={`warning-${w.kind}`}
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border whitespace-nowrap ${badgeStyle[w.kind]}`}
    >
      <Icon className="w-3 h-3" /> {w.label}
    </span>
  )
}
