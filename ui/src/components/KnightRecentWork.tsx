import { Link } from 'react-router-dom'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { formatCost, formatMsLadder, formatRelativeTime, until } from '../lib/format'
import { phaseStyle } from '../lib/status'
import { scheduleLink, type Schedule } from '../lib/schedules'
import { schedulesFor, taskRows } from '../lib/knightTasks'
import { sanitizeText } from '../lib/untrusted'
import { ListState, Badge } from './ui'
import { TraceLink } from './TraceLink'

const POLL_MS = 30_000

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Drawer section: the knight's last gateway tasks and the schedules that target it. */
export function KnightRecentWork({ knight, table }: { knight: string; table?: string }) {
  const tasksQ = usePolledFetch<unknown>(`/api/gateway/tasks?knight=${encodeURIComponent(knight)}&limit=10`, POLL_MS, null)
  const schedQ = usePolledFetch<{ schedules?: Schedule[] } | Schedule[] | null>('/api/schedules', POLL_MS, null)
  const rows = taskRows(tasksQ.data)
  const all = Array.isArray(schedQ.data) ? schedQ.data : schedQ.data?.schedules
  const schedules = schedulesFor(knight, table, all)

  return (
    <section aria-label="recent work" className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Recent tasks</h3>
        <ListState loading={tasksQ.loading} error={tasksQ.error} count={rows.length} what="recent tasks"
          emptyTitle="No recent tasks" onRetry={tasksQ.refresh}>
          <ul className="divide-y divide-roundtable-steel text-sm">
            {rows.map((t) => (
              <li key={t.taskId} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <Badge tone={phaseStyle(cap(t.status)).tone} strength={phaseStyle(cap(t.status)).strength}>{t.status}</Badge>
                <Link to={`/running?task=${encodeURIComponent(t.taskId)}`} className="text-blue-400 hover:text-blue-300 font-mono text-xs truncate max-w-[10rem]" title={t.taskId}>{t.taskId}</Link>
                <span className="text-gray-400">{t.createdAt ? formatRelativeTime(t.createdAt) : '—'}</span>
                <span className="text-gray-400">{formatMsLadder(t.durationMs)}</span>
                <span className="text-gray-400">{t.cost != null ? formatCost(t.cost) : '—'}</span>
                <TraceLink traceId={t.traceId} />
              </li>
            ))}
          </ul>
        </ListState>
        {tasksQ.error && tasksQ.errorStatus === 503 && <p className="text-xs text-gray-500">The gateway is not configured on this dashboard.</p>}
      </div>
      <div>
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Schedules</h3>
        <ListState loading={schedQ.loading} error={schedQ.error} count={schedules.length} what="schedules"
          emptyTitle="No schedules target this knight" onRetry={schedQ.refresh}>
          <ul className="divide-y divide-roundtable-steel text-sm">
            {schedules.map((s) => (
              <li key={`${s.namespace}/${s.name}`} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <Link to={scheduleLink(s.namespace, s.name)} className="text-blue-400 hover:text-blue-300">{sanitizeText(s.name)}</Link>
                <code className="text-xs text-gray-400">{sanitizeText(s.cron)}</code>
                <span className="text-gray-400">{s.suspended ? '—' : until(s.nextRunAt)}</span>
                {s.suspended && <Badge tone="amber">Suspended</Badge>}
              </li>
            ))}
          </ul>
        </ListState>
        {schedQ.error && schedQ.errorStatus === 503 && <p className="text-xs text-gray-500">The gateway is not configured on this dashboard.</p>}
      </div>
    </section>
  )
}
