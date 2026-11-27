import type { Chain } from '../lib/types'
import { timelineRows } from '../lib/chainTimeline'
import { phaseColor } from '../lib/status'
import { formatSecondsLadder } from '../lib/format'
import { CostTag } from './CostTag'

/** Chain run timeline: one bar per step on the run's shared time axis. */
export function ChainTimeline({ chain, now = Date.now(), selected, onSelect }: {
  chain: Chain
  now?: number
  selected?: string | null
  onSelect?: (name: string) => void
}) {
  const rows = timelineRows(chain, now)
  const byName = new Map((chain.steps ?? []).map(s => [s.name, s]))
  if (rows.length === 0) return <p className="text-xs text-gray-500">No steps.</p>
  return (
    <div className="space-y-1" role="list" aria-label="Chain run timeline">
      {rows.map(row => {
        const dur = row.durationMs === undefined ? null : formatSecondsLadder(row.durationMs / 1000)
        const label = `${row.name}: ${row.phase}${dur ? `, ${dur}` : ', no bar'}`
        return (
          <div key={row.name} role="listitem"
            className={`flex items-center gap-2 text-xs rounded px-1 ${selected === row.name ? 'bg-roundtable-gold/10' : ''}`}>
            <button type="button" onClick={() => onSelect?.(row.name)}
              className="w-32 shrink-0 truncate text-left text-gray-300 hover:text-white" title={row.name}>
              {row.name}
            </button>
            <div className="relative h-5 flex-1 bg-roundtable-navy rounded">
              {row.startPct !== undefined && (
                <div data-testid={`bar-${row.name}`} role="img" aria-label={label}
                  onClick={() => onSelect?.(row.name)}
                  className={`absolute top-0 h-5 rounded border cursor-pointer overflow-hidden whitespace-nowrap px-1 leading-5 ${phaseColor(row.phase)}`}
                  style={{ left: `${row.startPct}%`, width: `${row.widthPct}%`, minWidth: '2px' }}>
                  {row.rounds?.map(r => (
                    <span key={r.iteration} data-testid={`round-${row.name}-${r.iteration}`}
                      aria-label={`Round ${r.iteration}: ${formatSecondsLadder(r.durationMs / 1000)}`}
                      title={`Round ${r.iteration}: ${formatSecondsLadder(r.durationMs / 1000)}`}
                      className="absolute top-0 h-5 border-l border-r border-black/40 bg-white/20"
                      style={{
                        left: `${row.widthPct ? ((r.startPct - (row.startPct ?? 0)) / row.widthPct) * 100 : 0}%`,
                        width: `${row.widthPct ? (r.widthPct / row.widthPct) * 100 : 100}%`,
                      }} />
                  ))}
                </div>
              )}
            </div>
            <span className="w-24 shrink-0 text-gray-400">{row.phase}{row.rounds ? ` · ${row.rounds.length}r` : ''}</span>
            <span className="w-14 shrink-0 text-right text-gray-400">{dur ?? '—'}</span>
            <CostTag costUSD={row.costUSD} notional={byName.get(row.name)?.costNotional} className="w-24 shrink-0 justify-end text-gray-300" />
          </div>
        )
      })}
    </div>
  )
}
