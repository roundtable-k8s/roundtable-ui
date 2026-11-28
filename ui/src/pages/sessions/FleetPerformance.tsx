import { useState, useCallback } from 'react'
import { getKnightConfig } from '../../lib/knights'
import { SESSION_TIMEOUT_MS } from '../../hooks/useKnightSession'
import type { KnightSessionStats } from '../../hooks/useKnightSession'
import type { Knight } from '../../hooks/useFleet'
import { apiGet } from '../../lib/api'
import { ProgressBar } from '../../components/ui'
import { formatCost, formatNumber } from '../../lib/format'

// Fetch fleet-wide stats for performance comparison (#50)
export function useFleetPerf(knights: Knight[]) {
  const [allKnightStats, setAllKnightStats] = useState<Record<string, KnightSessionStats>>({})
  const [showFleetPerf, setShowFleetPerf] = useState(false)
  const fetchFleetPerf = useCallback(async () => {
    setShowFleetPerf(true)
    const results: Record<string, KnightSessionStats> = {}
    await Promise.all(knights.map(async k => {
      try {
        const data = await apiGet<KnightSessionStats>(`/api/fleet/${encodeURIComponent(k.name)}/session?type=stats`, { timeoutMs: SESSION_TIMEOUT_MS })
        results[k.name] = { ...data, supported: true }
      } catch {}
    }))
    setAllKnightStats(results)
  }, [knights])
  return { allKnightStats, showFleetPerf, fetchFleetPerf }
}

// Fleet performance comparison (#50)
export function FleetPerformance({ allKnightStats }: { allKnightStats: Record<string, KnightSessionStats> }) {
  return (
    <>
    {Object.keys(allKnightStats).length > 0 && (
      <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-400 mb-3">📊 Fleet Performance Comparison</h3>
        <div className="space-y-2">
          {Object.entries(allKnightStats)
            .filter(([, s]) => s.session)
            .sort((a, b) => (b[1].session?.cost || 0) - (a[1].session?.cost || 0))
            .map(([name, s]) => {
              const cfg = getKnightConfig(name)
              const maxCost = Math.max(...Object.values(allKnightStats).map(s => s.session?.cost || 0))
              const barWidth = maxCost > 0 ? ((s.session?.cost || 0) / maxCost * 100) : 0
              return (
                <div key={name} className="flex items-center gap-3">
                  <span className="w-24 text-xs text-gray-300 truncate">{cfg.emoji} {name}</span>
                  <div className="flex-1 relative">
                    <ProgressBar percent={barWidth} fillClass="bg-roundtable-gold/30" heightClass="h-5" />
                    <span className="absolute right-2 top-0.5 text-[10px] text-gray-400">
                      {formatCost(s.session?.cost || 0)} · {s.session?.toolCalls || 0} tools · {formatNumber(s.session?.tokens.total || 0)} tokens
                    </span>
                  </div>
                </div>
              )
            })}
        </div>
      </div>
    )}
    </>
  )
}
