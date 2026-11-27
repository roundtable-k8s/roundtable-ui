import { AlertTriangle, Info } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { formatRelativeTime } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { ListState } from './ui'

const POLL_MS = 15000

export interface KnightEvent {
  type: string
  reason: string
  message: string
  count: number
  firstTimestamp?: string
  lastTimestamp?: string
  reportingComponent?: string
}

/** Recent Kubernetes events of a knight, for the detail drawer (#529). */
export function KnightEventsPanel({ knight }: { knight: string }) {
  const { data, loading, error, refresh } = usePolledFetch<KnightEvent[]>(
    `/api/fleet/${encodeURIComponent(knight)}/events`, POLL_MS, [])
  return (
    <div data-testid="events-panel">
      <ListState loading={loading} error={error} count={data.length} what="events" onRetry={refresh}
        emptyTitle="No recent events">
        <ul className="space-y-2">
          {data.map((e, i) => {
            const warning = e.type === 'Warning'
            return (
              <li key={`${e.reason}-${e.lastTimestamp ?? i}-${i}`} data-type={e.type}
                className={`rounded-lg border p-3 text-xs ${warning ? 'bg-amber-500/10 border-amber-500/30' : 'bg-roundtable-slate border-roundtable-steel/50'}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {warning
                    ? <span className="inline-flex items-center gap-1 font-medium text-amber-300"><AlertTriangle className="w-3 h-3" aria-hidden />Warning</span>
                    : <span className="inline-flex items-center gap-1 text-gray-400"><Info className="w-3 h-3" aria-hidden />{e.type || 'Normal'}</span>}
                  <span className="font-mono text-gray-200">{sanitizeText(e.reason)}</span>
                  {e.count > 1 && <span className="text-gray-400">×{e.count}</span>}
                  <span className="ml-auto text-gray-500">{formatRelativeTime(e.lastTimestamp ?? null)}</span>
                </div>
                <p className="mt-1 text-gray-300 break-words">{sanitizeText(e.message)}</p>
              </li>
            )
          })}
        </ul>
      </ListState>
    </div>
  )
}
