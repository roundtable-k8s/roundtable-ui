import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { DollarSign, Link2, TrendingUp, Calendar, ChevronDown, ChevronRight, Download } from 'lucide-react'
import { EmptyState, ProgressBar } from './ui'
import { CostTag } from './CostTag'
import { formatCost, formatTimestamp } from '../lib/format'
import { getKnightConfig } from '../lib/knights'
import { uniqueKeys } from '../lib/events'
import { buildCostPanelData, type CostEntry } from '../lib/dashboardCost'
import type { ChainCostRow } from '../lib/chainCost'

export type CostTimeRange = 'day' | 'week' | 'month'

export interface CostDetailsPanelProps {
  entries: CostEntry[]
  chainRows: ChainCostRow[]
  timeRange: CostTimeRange
  onTimeRange: (range: CostTimeRange) => void
  expanded: boolean
  onToggle: () => void
  onDownloadCsv: () => void
  /** What span of time the buffered task events cover (#661). */
  eventsCoverage: string
  /** Set when the chain list is truncated. */
  chainsNote?: string | null
}

/** The collapsible "Cost Details" section of the dashboard. */
export function CostDetailsPanel({
  entries, chainRows, timeRange, onTimeRange, expanded, onToggle, onDownloadCsv, eventsCoverage, chainsNote,
}: CostDetailsPanelProps) {
  const costPanelData = useMemo(() => buildCostPanelData(entries), [entries])
  const chainCostRows = chainRows
  return (
    <div className="mt-6 bg-roundtable-slate border border-roundtable-steel rounded-xl overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-roundtable-steel/20 transition-colors"
      >
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-roundtable-gold" />
          Cost Details
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">
            {entries.length} tasks · {eventsCoverage}
          </span>
          {expanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
        </div>
      </button>

      {expanded && (
        <div className="px-5 pb-5">
          {/* Summary: task figures cover the event buffer only */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-4">
              <span className="text-2xl font-bold text-roundtable-gold">{formatCost(costPanelData.totalCost)}</span>
            </div>
            <div className="flex gap-4 text-sm text-gray-400">
              <span><span className="text-white font-medium">{entries.length}</span> tasks</span>
              <span><span className="text-white font-medium">{costPanelData.costByKnight.length}</span> active knights</span>
              <span>avg <span className="text-roundtable-gold font-medium">{entries.length > 0 ? formatCost(costPanelData.totalCost / entries.length) : '$0.00'}</span>/task</span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <button
                type="button"
                onClick={onDownloadCsv}
                aria-label="Download CSV"
                className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-roundtable-steel/50 text-gray-300 hover:text-white transition-colors"
              >
                <Download className="w-3.5 h-3.5" /> Download CSV
              </button>
              <span className="text-xs text-gray-500" data-testid="cost-coverage">Task figures: {eventsCoverage}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
            {/* Cost by Knight */}
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-roundtable-gold" /> Cost by Knight
              </h3>
              {costPanelData.costByKnight.length === 0 ? (
                <EmptyState title="No cost data available" />
              ) : (
                <div className="space-y-3">
                  {costPanelData.costByKnight.map(({ knight, cost, tasks, failures }) => {
                    const cfg = getKnightConfig(knight)
                    const barWidth = (cost / (costPanelData.costByKnight[0]?.cost || 1)) * 100
                    return (
                      <div key={knight} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2">
                            <span className={cfg.color}>{cfg.emoji}</span>
                            <span className="text-gray-300 capitalize">{knight}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-gray-500 text-xs">{tasks} tasks</span>
                            {failures > 0 && <span className="text-red-400 text-xs">{failures} failed</span>}
                            <span className="text-roundtable-gold font-medium">{formatCost(cost)}</span>
                          </div>
                        </div>
                        <ProgressBar percent={barWidth} fillClass="bg-roundtable-gold/40" heightClass="h-2" />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Daily trend */}
            <div>
              <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-blue-400" /> Daily Cost Trend
              </h3>
              {costPanelData.dailyCosts.length === 0 ? (
                <EmptyState title="No trend data available" />
              ) : (
                <div className="space-y-2">
                  {costPanelData.dailyCosts.map(({ day, date, cost }) => {
                    const maxCost = Math.max(...costPanelData.dailyCosts.map(d => d.cost), 1)
                    return (
                      <div key={day} className="space-y-1">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-gray-400">{date}</span>
                          <span className="text-roundtable-gold font-medium">{formatCost(cost)}</span>
                        </div>
                        <ProgressBar percent={(cost / maxCost) * 100} fillClass="bg-blue-400/40" heightClass="h-2" />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Cost by chain */}
          <div className="mb-6">
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <Link2 className="w-4 h-4 text-roundtable-gold" /> Cost by Chain
              {chainsNote && (
                <span className="text-xs text-yellow-400 font-normal" data-testid="cost-chains-truncated">{chainsNote}</span>
              )}
              <span className="ml-auto flex gap-1.5 font-normal">
      {(['day', 'week', 'month'] as const).map(range => (
        <button
          key={range}
          onClick={() => onTimeRange(range)}
          className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
            timeRange === range
              ? 'bg-roundtable-gold/20 text-roundtable-gold border border-roundtable-gold/30'
              : 'bg-roundtable-steel/50 text-gray-400 hover:text-gray-300'
          }`}
        >
          {range === 'day' ? 'Last 24h' : range === 'week' ? 'Last 7 days' : 'Last 30 days'}
        </button>
      ))}
              </span>
            </h3>
            {chainCostRows.length === 0 ? (
              <EmptyState title="No chain runs in this range" />
            ) : (
              <div className="overflow-x-auto">
                <table aria-label="Cost by chain" className="w-full">
                  <thead>
                    <tr className="border-b border-roundtable-steel">
                      <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Chain</th>
                      <th scope="col" className="text-right text-gray-400 text-xs font-medium pb-2">Runs</th>
                      <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Latest run</th>
                      <th scope="col" className="text-right text-gray-400 text-xs font-medium pb-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chainCostRows.map(row => (
                      <tr key={row.key} className="border-b border-roundtable-steel/30 last:border-0">
                        <td className="py-2">
                          <Link to={`/chains?chain=${encodeURIComponent(row.key)}`} className="text-gray-300 text-sm hover:underline">{row.key}</Link>
                        </td>
                        <td className="py-2 text-right text-gray-400 text-xs">{row.runs}</td>
                        <td className="py-2">
                          <span className="text-gray-500 text-xs">{row.latest ? formatTimestamp(row.latest) : '—'}</span>
                        </td>
                        <td className="py-2 text-right text-roundtable-gold font-medium text-sm">
                          <CostTag
                            costUSD={row.costUSD === null ? null : String(row.costUSD)}
                            notionalUSD={String(row.notionalUSD)}
                            className="justify-end"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Most expensive tasks */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-green-400" /> Most Expensive Tasks
            </h3>
            {costPanelData.topTasks.length === 0 ? (
              <EmptyState title="No task data available" />
            ) : (
              <div className="overflow-x-auto">
                <table aria-label="Most expensive tasks" className="w-full">
                  <thead>
                    <tr className="border-b border-roundtable-steel">
                      <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Knight</th>
                      <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Task ID</th>
                      <th scope="col" className="text-left text-gray-400 text-xs font-medium pb-2">Time</th>
                      <th scope="col" className="text-right text-gray-400 text-xs font-medium pb-2">Cost</th>
                      <th scope="col" className="text-center text-gray-400 text-xs font-medium pb-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => { const taskKeys = uniqueKeys(costPanelData.topTasks.map(t => `${t.knight}:${t.taskId}`)); return costPanelData.topTasks.map((task, i) => {
                      const cfg = getKnightConfig(task.knight)
                      return (
                        <tr key={taskKeys[i]} className="border-b border-roundtable-steel/30 last:border-0">
                          <td className="py-2">
                            <div className="flex items-center gap-2">
                              <span className={cfg.color}>{cfg.emoji}</span>
                              <span className="text-gray-300 text-sm capitalize">{task.knight}</span>
                            </div>
                          </td>
                          <td className="py-2">
                            <span className="text-gray-400 text-xs font-mono truncate max-w-[200px] block">{task.taskId}</span>
                          </td>
                          <td className="py-2">
                            <span className="text-gray-500 text-xs">{formatTimestamp(task.timestamp)}</span>
                          </td>
                          <td className="py-2 text-right">
                            <span className="text-roundtable-gold font-medium text-sm">{formatCost(task.cost)}</span>
                          </td>
                          <td className="py-2 text-center">
                            <span className={`text-xs px-2 py-0.5 rounded-full ${task.success ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                              {task.success ? 'Success' : 'Failed'}
                            </span>
                          </td>
                        </tr>
                      )
                    }) })()}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
