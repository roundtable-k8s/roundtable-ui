import type { QueueSample, ScaleEvent } from '../lib/queues'
import { scaleEvents } from '../lib/queues'

/** Series colors, shared with the legend on the Queues page. */
export const PENDING_COLOR = '#D4AF37' // roundtable gold
export const REPLICAS_COLOR = '#38BDF8' // sky-400

/**
 * Pending tasks against replicas over time, on one shared count axis, with
 * scale events marked as ticks (▲ up / ▼ down). Hover gives a text summary.
 */
export function QueueSparkline({ samples, width = 140, height = 36 }: {
  samples: QueueSample[]
  width?: number
  height?: number
}) {
  if (samples.length < 2) {
    return <span className="text-xs text-gray-600">collecting…</span>
  }

  const pad = 3
  const t0 = samples[0].t
  const t1 = samples[samples.length - 1].t
  const span = Math.max(t1 - t0, 1)
  const yMax = Math.max(1, ...samples.map(s => Math.max(s.pending, s.replicas)))
  const x = (t: number) => pad + ((t - t0) / span) * (width - 2 * pad)
  const y = (v: number) => height - pad - (v / yMax) * (height - 2 * pad)

  const pendingPath = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.t).toFixed(1)},${y(s.pending).toFixed(1)}`).join(' ')
  // Replicas are a step function: hold the value until the next sample.
  const replicaPath = samples.map((s, i) => {
    if (i === 0) return `M${x(s.t).toFixed(1)},${y(s.replicas).toFixed(1)}`
    return `H${x(s.t).toFixed(1)} V${y(s.replicas).toFixed(1)}`
  }).join(' ')

  const events: ScaleEvent[] = scaleEvents(samples)
  const last = samples[samples.length - 1]
  const peak = Math.max(...samples.map(s => s.pending))
  const summary = `Pending now ${last.pending} (peak ${peak}), replicas ${last.replicas}` +
    (events.length ? `; ${events.length} scale event${events.length === 1 ? '' : 's'}: ` +
      events.map(e => `${e.direction} ${e.from}→${e.to} at ${new Date(e.t).toLocaleTimeString()}`).join(', ')
      : '; no scale events')

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={summary}
      className="overflow-visible"
    >
      <title>{summary}</title>
      <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} stroke="#334155" strokeWidth={1} />
      {events.map(e => (
        <g key={e.t} data-testid={`scale-${e.direction}`}>
          <line x1={x(e.t)} x2={x(e.t)} y1={pad} y2={height - pad} stroke="#94A3B8" strokeWidth={1} strokeDasharray="2 2" />
          <text x={x(e.t)} y={pad + 1} fontSize={8} textAnchor="middle" fill="#CBD5E1">
            {e.direction === 'up' ? '▲' : '▼'}
          </text>
        </g>
      ))}
      <path d={replicaPath} fill="none" stroke={REPLICAS_COLOR} strokeWidth={1.5} strokeDasharray="3 2" />
      <path d={pendingPath} fill="none" stroke={PENDING_COLOR} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
