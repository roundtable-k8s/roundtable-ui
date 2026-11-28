import { Settings } from 'lucide-react'
import type { Knight } from '../../hooks/useFleet'

export function ConfigurationSection({ knightDetail }: { knightDetail: Knight }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <Settings className="w-4 h-4" />
        Configuration
      </h3>
      <div className="bg-roundtable-slate rounded-lg p-3 space-y-2">
        {knightDetail.suspend && (
          <div className="flex justify-between text-sm items-center">
            <span className="text-gray-400">Status</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">Suspended</span>
          </div>
        )}
        {knightDetail.model && (
          <div className="flex justify-between text-sm items-center">
            <span className="text-gray-400">Model</span>
            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono">{knightDetail.model}</span>
          </div>
        )}
        {knightDetail.runtime && (
          <div className="flex justify-between text-sm items-center">
            <span className="text-gray-400">Runtime</span>
            <span className={`text-xs px-2 py-0.5 rounded-full border ${
              knightDetail.runtime === 'sandbox'
                ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
            }`}>{knightDetail.runtime}</span>
          </div>
        )}
        {knightDetail.concurrency != null && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Concurrency Limit</span>
            <span className="text-gray-200">{knightDetail.concurrency}</span>
          </div>
        )}
        {knightDetail.taskTimeoutSeconds && (
          <div className="flex justify-between text-sm">
            <span className="text-gray-400">Task Timeout</span>
            <span className="text-gray-200">{knightDetail.taskTimeoutSeconds}s</span>
          </div>
        )}
      </div>
    </div>
  )
}
