import { Link } from 'react-router-dom'
import { useHealth } from '../hooks/useHealth'
import { useOpenDeadLetters } from '../hooks/useOpenDeadLetters'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useTableFilter } from '../hooks/useTableFilter'
import { withTable } from '../lib/tables'
import { glanceItems, type GlanceTone } from '../lib/glance'
import type { Knight } from '../hooks/useFleet'
import type { ScheduleList } from '../lib/schedules'
import type { KnightQueue } from '../lib/queues'

const POLL_MS = 60000

const TONE: Record<GlanceTone, string> = {
  ok: 'border-green-500/30 bg-green-500/10 text-green-300',
  warn: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300',
  bad: 'border-red-500/30 bg-red-500/10 text-red-300',
  unknown: 'border-gray-500/30 bg-gray-500/10 text-gray-300',
}

/** One-line "is the fleet fine?" strip for the Command Center (#480). A failed source reads "unknown", never "ok". */
/** `knights` is the Dashboard's own fleet poll (null while unknown or failed), so the fleet is not fetched twice. */
export function GlanceStrip({ knights }: { knights: Pick<Knight, 'status'>[] | null }) {
  const { table } = useTableFilter()
  const health = useHealth(POLL_MS)
  const deadLetters = useOpenDeadLetters(table, POLL_MS)
  const schedules = usePolledFetch<ScheduleList | null>(withTable('/api/schedules', table), POLL_MS, null)
  const queues = usePolledFetch<KnightQueue[] | null>(withTable('/api/queues', table), POLL_MS, null)

  // Unknown until the source has loaded; a later failed poll also reads as unknown.
  const items = glanceItems({
    health,
    knights,
    deadLetters: deadLetters.error ? null : deadLetters,
    schedules: schedules.error || !Array.isArray(schedules.data?.schedules) ? null : schedules.data.schedules,
    queues: queues.error || !Array.isArray(queues.data) ? null : queues.data,
  })

  return (
    <ul aria-label="Fleet health at a glance" className="mb-6 flex flex-wrap gap-2">
      {items.map((i) => (
        <li key={i.id}>
          <Link to={i.to} data-tone={i.tone} className={`inline-block rounded-full border px-3 py-1 text-xs font-medium hover:brightness-125 ${TONE[i.tone]}`}>
            {i.label}
          </Link>
        </li>
      ))}
    </ul>
  )
}
