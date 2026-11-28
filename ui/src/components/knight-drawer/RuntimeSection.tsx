import { Cpu } from 'lucide-react'
import { formatUptime } from '../../lib/format'
import type { KnightSessionStats } from '../../hooks/useKnightSession'

export function RuntimeSection({ runtime }: { runtime: NonNullable<KnightSessionStats['runtime']> }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <Cpu className="w-4 h-4" />
        Runtime
      </h3>
      <div className="bg-roundtable-slate rounded-lg p-3 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Model</span>
          <span className="text-gray-200 font-mono text-xs">{runtime.model}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Uptime</span>
          <span className="text-gray-200">{formatUptime(runtime.uptime)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Active Tasks</span>
          <span className={runtime.activeTasks > 0 ? 'text-yellow-400' : 'text-gray-200'}>
            {runtime.activeTasks}
          </span>
        </div>
      </div>
    </div>
  )
}
