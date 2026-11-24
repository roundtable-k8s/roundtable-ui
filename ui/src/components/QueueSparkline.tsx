import { useState } from 'react'
import type { QueueSample, ScaleEvent } from '../lib/queues'
import { sparkGeometry, sparkPath } from '../lib/queues'

const W = 200
const H = 24
const GAP = 6

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function eventLabel(e: ScaleEvent): string {
  const arrow = e.direction === 'down' ? '▼' : '▲'
  const from = e.from != null ? `${e.from} → ` : ''
  return `${arrow} ${from}${e.to} replicas (${e.source})${e.reason ? `: ${e.reason}` : ''}`
}

/**
 * Two small charts on one shared time axis: pending tasks (line, top) and
 * replicas (step line, bottom). Scale events are marked on both with ▲/▼ so
 * the direction does not rely on colour. Hovering shows the nearest sample.
 */
export function QueueSparkline({ knight, samples, events }: {
  knight: string
  samples: QueueSample[]
  events: ScaleEvent[]
}) {
  const [hover, setHover] = useState<number | null>(null)

  if (samples.length < 2) {
    return <span className="text-xs text-gray-500">Collecting samples…</span>
  }

  const g = sparkGeometry(samples, events, W, H)
  const totalH = H * 2 + GAP
  const replicasTop = H + GAP

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * W : 0
    let best = 0
    for (let i = 1; i < g.pending.length; i++) {
      if (Math.abs(g.pending[i].x - x) < Math.abs(g.pending[best].x - x)) best = i
    }
    setHover(best)
  }

  const hs = hover != null ? samples[hover] : null
  const last = samples[samples.length - 1]

  return (
    <div className="relative inline-flex items-start gap-2" data-testid={`sparkline-${knight}`}>
      <div className="flex flex-col justify-between text-[10px] text-gray-400 leading-none" style={{ height: totalH }}>
        <span>pending</span>
        <span>replicas</span>
      </div>
      <svg
        width={W}
        height={totalH}
        viewBox={`0 0 ${W} ${totalH}`}
        role="img"
        aria-label={`${knight}: pending tasks and replicas over the last ${formatClock(g.t0)}–${formatClock(g.t1)}; now ${last.pending ?? 'unknown'} pending, ${last.replicas} replicas, ${events.length} scale events`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className="overflow-visible"
      >
        {/* baselines */}
        <line x1={0} x2={W} y1={H} y2={H} className="stroke-roundtable-steel" strokeWidth={1} />
        <line x1={0} x2={W} y1={replicasTop + H} y2={replicasTop + H} className="stroke-roundtable-steel" strokeWidth={1} />

        {/* scale events: vertical rule across both charts + direction marker */}
        {g.events.map(({ x, event }, i) => (
          <g key={`${event.t}-${i}`} data-testid="scale-event">
            <title>{eventLabel(event)}</title>
            <line x1={x} x2={x} y1={0} y2={totalH} className="stroke-gray-500" strokeWidth={1} strokeDasharray="2 2" />
            <text x={x} y={replicasTop + H / 2 + 3} textAnchor="middle" fontSize={9} className="fill-gray-200">
              {event.direction === 'down' ? '▼' : '▲'}
            </text>
            {/* wider invisible hit target */}
            <rect x={x - 5} y={0} width={10} height={totalH} fill="transparent" />
          </g>
        ))}

        <path d={sparkPath(g.pending)} fill="none" className="stroke-roundtable-gold" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <g transform={`translate(0 ${replicasTop})`}>
          <path d={sparkPath(g.replicas, true)} fill="none" className="stroke-sky-400" strokeWidth={2} strokeLinejoin="round" />
        </g>

        {hover != null && (
          <line x1={g.pending[hover].x} x2={g.pending[hover].x} y1={0} y2={totalH} className="stroke-gray-300" strokeWidth={1} />
        )}
      </svg>
      {hs && (
        <div className="absolute left-full top-0 ml-2 z-10 whitespace-nowrap rounded-md border border-roundtable-steel bg-roundtable-navy px-2 py-1 text-[11px] text-gray-200 shadow-lg pointer-events-none">
          <div className="text-gray-400">{formatClock(Date.parse(hs.t))}</div>
          <div>{hs.pending ?? '—'} pending · {hs.ackPending ?? '—'} in flight</div>
          <div>{hs.readyReplicas}/{hs.replicas} ready{hs.maxReplicas != null ? ` · max ${hs.maxReplicas}` : ''}</div>
        </div>
      )}
    </div>
  )
}
