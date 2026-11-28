import { useMemo } from 'react'
import { Inbox, AlertTriangle, Clock, ExternalLink } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useTableFilter } from '../hooks/useTableFilter'
import { withTable } from '../lib/tables'
import { PageHeader, RefreshButton, ListState, TableBadge, DataTable } from '../components/ui'
import { QueueSparkline } from '../components/QueueSparkline'
import {
  OLDEST_WAIT_WARN_SECONDS,
  formatWait,
  latestMaxReplicas,
  queueWarnings,
  safeExternalUrl,
  type KnightQueue,
  type KnightQueueHistory,
  type QueueWarning,
} from '../lib/queues'

const QUEUES_URL = '/api/queues'
const HISTORY_URL = '/api/queues/history?since=1h'

function WarningBadge({ w }: { w: QueueWarning }) {
  const Icon = w.kind === 'oldest-wait' ? Clock : AlertTriangle
  const cls = w.kind === 'saturated'
    ? 'bg-red-500/10 text-red-300 border-red-500/30'
    : 'bg-amber-500/10 text-amber-300 border-amber-500/30'
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs whitespace-nowrap ${cls}`}
      title={w.detail}
      data-testid={`warning-${w.kind}`}
    >
      <Icon className="w-3 h-3" aria-hidden />
      {w.label}
    </span>
  )
}

export function QueuesTable({ queues, history, showTable = false }: {
  showTable?: boolean
  queues: KnightQueue[]
  history: KnightQueueHistory[]
}) {
  const byKnight = useMemo(() => new Map(history.map(h => [h.knight, h])), [history])

  return (
    <DataTable label="Queues" columns={[
      { key: 'knight', header: 'Knight' },
      { key: 'pending', header: 'Pending', align: 'right' },
      { key: 'ack-pending', header: 'Ack pending', align: 'right' },
      { key: 'redelivered', header: 'Redelivered', align: 'right' },
      { key: 'oldest-wait', header: 'Oldest wait', align: 'right' },
      { key: 'free-slots', header: 'Free slots', align: 'right' },
      { key: 'replicas', header: 'Replicas', align: 'right' },
      { key: 'last-hour', header: 'Last hour' },
    ]}>
          {queues.map(q => {
            const h = byKnight.get(q.knight)
            const max = latestMaxReplicas(h)
            const warnings = queueWarnings(q, max)
            const grafana = safeExternalUrl(h?.grafanaUrl)
            const unavailable = !q.consumerFound || !!q.error
            return (
              <tr key={q.knight} className="border-b border-roundtable-steel/50 last:border-0 align-top" data-testid={`queue-row-${q.knight}`}>
                <td className="px-4 py-3">
                  <div className="font-medium text-white">{q.knight} {showTable && <TableBadge table={q.table} />}</div>
                  <div className="text-xs text-gray-500 font-mono">{q.consumer}</div>
                  {q.error && <div className="text-xs text-red-400 mt-1">{q.error}</div>}
                  {!q.error && !q.consumerFound && <div className="text-xs text-gray-500 mt-1">No consumer yet</div>}
                  {warnings.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {warnings.map(w => <WarningBadge key={w.kind} w={w} />)}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-200">{unavailable ? '—' : q.pending}</td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-200">{unavailable ? '—' : q.ackPending}</td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-200">{unavailable ? '—' : q.redelivered}</td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-200" title={q.oldestPendingAt}>
                  {unavailable ? '—' : formatWait(q.oldestWaitSeconds)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-200">
                  {q.freeSlots}
                  <span className="text-gray-500"> / {q.concurrency * q.readyReplicas}</span>
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-200" title={`${q.readyReplicas} ready of ${q.replicas}`}>
                  {q.replicas}
                  <span className="text-gray-500"> / {max ?? '—'}</span>
                </td>
                <td className="px-4 py-3">
                  {h ? (
                    <QueueSparkline knight={q.knight} samples={h.samples} events={h.events} />
                  ) : (
                    <span className="text-xs text-gray-500">No history</span>
                  )}
                  {grafana && (
                    <a
                      href={grafana}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-xs text-roundtable-gold hover:underline"
                    >
                      Grafana <ExternalLink className="w-3 h-3" aria-hidden />
                    </a>
                  )}
                </td>
              </tr>
            )
          })}
    </DataTable>
  )
}

export function QueuesPage() {
  const { table } = useTableFilter()
  const { data: queues, loading, error, updatedAt, refresh } = usePolledFetch<KnightQueue[]>(withTable(QUEUES_URL, table), 5000, [])
  const { data: history, error: historyError, refresh: refreshHistory } = usePolledFetch<KnightQueueHistory[]>(HISTORY_URL, 15000, [])

  const totals = useMemo(() => ({
    pending: queues.reduce((n, q) => n + (q.consumerFound ? q.pending : 0), 0),
    ackPending: queues.reduce((n, q) => n + (q.consumerFound ? q.ackPending : 0), 0),
    oldest: Math.max(0, ...queues.map(q => q.oldestWaitSeconds || 0)),
  }), [queues])

  return (
    <div>
      <PageHeader
        icon={Inbox}
        title="Queues"
        subtitle={queues.length === 0 && (loading || error)
          ? `Tasks waiting per knight · ${loading ? '…' : '—'} pending · ${loading ? '…' : '—'} in flight`
          : `Tasks waiting per knight · ${totals.pending} pending · ${totals.ackPending} in flight · oldest ${formatWait(totals.oldest)}`}
      >
        <RefreshButton onClick={() => { refresh(); refreshHistory() }} loading={loading} updatedAt={updatedAt} />
      </PageHeader>

      {historyError && !error && (
        <p className="mb-4 text-xs text-gray-500">Scaling history unavailable: {historyError}</p>
      )}

      <ListState loading={loading} error={error} count={queues.length} what="queues" icon={Inbox} onRetry={refresh}
        emptyTitle="No knight queues found.">
        <QueuesTable queues={queues} history={history} showTable={!table} />
      </ListState>

      <p className="mt-3 text-xs text-gray-500">
        Warnings: oldest wait over {formatWait(OLDEST_WAIT_WARN_SECONDS)}, or tasks pending with no free slots while replicas are at max.
        History is sampled every 15 s and kept in memory for 6 h.
      </p>
    </div>
  )
}
