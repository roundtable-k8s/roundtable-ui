import { BarChart3 } from 'lucide-react'
import type { KnightSessionStats } from '../../hooks/useKnightSession'
import type { Knight } from '../../hooks/useFleet'
import { StatCard } from '../../components/ui'
import { formatCost, formatNumber } from '../../lib/format'

interface Props {
  stats: KnightSessionStats | null
  selectedKnight: string
  knights: Knight[]
  config: { emoji?: string } | null
  onFleetComparison: () => void
}

// Knight stats bar (live session only; the caller skips it for archived sessions)
export function KnightStatsBar({ stats, selectedKnight, knights, config, onFleetComparison }: Props) {
  return (
    <>
    {stats?.supported === false && (
      <div className="bg-amber-900/20 border border-amber-500/30 rounded-lg p-4 mb-4">
        <p className="text-amber-400 text-sm flex items-center gap-2">
          ℹ️ This knight does not support session introspection. Basic fleet info shown instead.
        </p>
        {config && (
          <div className="mt-2 text-xs text-gray-400">
            <span className="font-medium">{config.emoji} {selectedKnight}</span> · 
            <span className="ml-2">Domain: {knights.find(k => k.name === selectedKnight)?.domain || 'unknown'}</span> · 
            <span className="ml-2">Status: {knights.find(k => k.name === selectedKnight)?.status || 'unknown'}</span>
          </div>
        )}
      </div>
    )}
    {stats?.session && stats.supported !== false && (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard label="Messages" value={stats.session.totalMessages} />
        <StatCard label="Tool Calls" value={stats.session.toolCalls} color="text-purple-400" />
        <StatCard label="Tokens" value={formatNumber(stats.session.tokens.total)} />
        <StatCard label="Cost" value={formatCost(stats.session.cost)} color="text-roundtable-gold" />
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-3 flex items-center justify-center">
          <button onClick={onFleetComparison}
            className="text-xs text-gray-400 hover:text-roundtable-gold flex items-center gap-1">
            <BarChart3 className="w-4 h-4" /> Fleet Comparison
          </button>
        </div>
      </div>
    )}
    {stats?.session && stats.supported !== false && (stats.pods?.length ?? 0) > 1 && (
      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs" aria-label="Per-pod breakdown">
        <span className="text-gray-500">
          Totals across {stats.respondedPods ?? stats.pods!.length}/{stats.podCount ?? stats.pods!.length} pods:
        </span>
        {stats.pods!.map(p => (
          <span key={p.pod} className={`px-2 py-1 rounded-full border ${p.ok ? 'border-roundtable-steel text-gray-300' : 'border-red-500/30 text-red-400'}`}>
            <span className="font-mono">{p.pod}</span>
            {p.ok
              ? ` · ${p.stats?.session?.totalMessages ?? 0} msgs · ${formatCost(p.stats?.session?.cost ?? 0)} · ${p.stats?.runtime?.activeTasks ?? 0} active`
              : ` · ${p.error || 'no reply'}`}
          </span>
        ))}
      </div>
    )}
    </>
  )
}
