import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Crown, Shield, DollarSign, ChevronDown, Settings, CheckSquare } from 'lucide-react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useTableFilter } from '../hooks/useTableFilter'
import { inTable } from '../lib/tables'
import { budgetText, countLabel, formatCost } from '../lib/format'
import type { RoundTable } from '../lib/types'
import { PageHeader, RefreshButton, ListState, PhaseBadge, ProgressBar } from '../components/ui'

export function RoundTablesPage() {
  const { data: allTables, loading, error, updatedAt, refresh } = usePolledFetch<RoundTable[]>('/api/roundtables', 15000, [])
  const { table } = useTableFilter()
  const roundTables = allTables.filter(rt => inTable(table, rt.name))
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set())

  const toggleCard = (name: string) => {
    setExpandedCards(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  return (
    <div>
      <PageHeader icon={Crown} title="Round Tables" subtitle={loading || (error && roundTables.length === 0) ? undefined : countLabel(roundTables.length, roundTables.length, 'round tables')}>
        <RefreshButton onClick={refresh} loading={loading} updatedAt={updatedAt} />
      </PageHeader>

      <ListState loading={loading} error={error} count={roundTables.length} what="round tables"
        icon={Crown} emptyTitle="No round tables found." onRetry={refresh}>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {roundTables.map(rt => {
            const expanded = expandedCards.has(rt.name)
            const hasDetail = rt.policies || rt.activeMissions != null || rt.totalTasksCompleted != null || rt.description || rt.suspend
            const totalCost = parseFloat(rt.totalCost) || 0
            const budget = budgetText(rt.costBudgetUSD)
            return (
              <div key={rt.name} className="bg-roundtable-slate border border-roundtable-steel rounded-xl hover:border-roundtable-gold/30 transition-colors">
                <div className="p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="text-lg font-bold text-white">{rt.name}</h3>
                      <p className="text-xs text-gray-500">{rt.namespace}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      {rt.suspend && <PhaseBadge phase="Suspended" />}
                      <PhaseBadge phase={rt.phase || 'Unknown'} />
                    </div>
                  </div>

                  <div className="space-y-3">
                    {/* Knights */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-sm text-gray-400">
                        <Shield className="w-4 h-4" />
                        Knights
                      </div>
                      <div className="text-sm">
                        <span className="text-green-400 font-medium">{rt.knightsReady}</span>
                        <span className="text-gray-500"> / {rt.knightsTotal}</span>
                      </div>
                    </div>

                    <p className="text-xs text-gray-500" data-testid={`breakdown-${rt.name}`}>
                      {rt.knightsReady} ready, {rt.knightsScaledToZero ?? 0} asleep, {rt.knightsSuspended ?? 0} suspended, {rt.knightsNotReady ?? 0} not ready
                    </p>

                    {/* Planner */}
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-gray-400">Mission planning</span>
                      {rt.plannerEnabled !== false && rt.plannerKnight ? (
                        <span>
                          Planner: <Link to={`/fleet?table=${encodeURIComponent(rt.name)}&knight=${encodeURIComponent(rt.plannerKnight)}`} className="text-roundtable-gold hover:underline">{rt.plannerKnight}</Link>
                        </span>
                      ) : (
                        <span className="text-gray-500">Planner: none</span>
                      )}
                    </div>

                    {/* Knight readiness bar */}
                    <ProgressBar
                      percent={rt.knightsTotal > 0 ? (rt.knightsReady / rt.knightsTotal) * 100 : 0}
                      fillClass="bg-green-500"
                    />

                    {/* NATS */}
                    {rt.natsPrefix && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-400">NATS Prefix</span>
                        <code className="text-blue-400 text-xs bg-blue-500/10 px-2 py-0.5 rounded">{rt.natsPrefix}</code>
                      </div>
                    )}

                    {/* Cost */}
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-1 text-gray-400">
                        <DollarSign className="w-3 h-3" />
                        Cost
                      </div>
                      <div>
                        <span className="text-roundtable-gold">{totalCost > 0 ? formatCost(totalCost) : '$0.00'}</span>
                        {budget !== 'unlimited' && (
                          <span className="text-gray-500"> / {budget}</span>
                        )}
                      </div>
                    </div>

                    {/* Quick stats if available */}
                    {rt.activeMissions != null && (
                      <div className="flex items-center justify-between text-sm">
                        <div className="flex items-center gap-1 text-gray-400">
                          <CheckSquare className="w-3 h-3" />
                          Active Missions
                        </div>
                        <span className={rt.activeMissions > 0 ? 'text-yellow-400 font-medium' : 'text-gray-400'}>{rt.activeMissions}</span>
                      </div>
                    )}
                  </div>

                  {/* Expand toggle */}
                  {hasDetail && (
                    <button
                      onClick={() => toggleCard(rt.name)}
                      aria-expanded={expanded}
                      aria-controls={`rt-${rt.name}-details`}
                      className="mt-4 w-full flex items-center justify-center gap-1 text-xs text-gray-500 hover:text-roundtable-gold transition-colors"
                    >
                      <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      {expanded ? 'Less' : 'More details'}
                    </button>
                  )}
                </div>

                {/* Expanded detail section */}
                {hasDetail && (
                  <div id={`rt-${rt.name}-details`} hidden={!expanded} className="border-t border-roundtable-steel/50 px-5 pb-5 pt-4 space-y-4">
                    {/* Description */}
                    {rt.description && (
                      <p className="text-sm text-gray-400 leading-relaxed">{rt.description}</p>
                    )}

                    {/* Policies */}
                    {rt.policies && (
                      <div>
                        <h4 className="text-xs font-medium text-gray-400 mb-2 flex items-center gap-1.5">
                          <Settings className="w-3.5 h-3.5" />
                          Policies
                        </h4>
                        <div className="bg-roundtable-navy rounded-lg p-3 space-y-1.5">
                          <div className="flex justify-between text-xs">
                            <span className="text-gray-500">Cost Budget</span>
                            <span className="text-roundtable-gold">{budgetText(rt.policies.costBudgetUSD)}</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-gray-500">Max Concurrent Plan Tasks</span>
                            <span className="text-gray-300">{rt.policies.maxConcurrentPlanTasks || 'unlimited'}</span>
                          </div>
                          <div className="flex justify-between text-xs">
                            <span className="text-gray-500">Max Missions</span>
                            <span className="text-gray-300">{rt.policies.maxMissions || 'unlimited'}</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Missions & tasks */}
                    {(rt.activeMissions != null || rt.totalTasksCompleted != null) && (
                      <div className="bg-roundtable-navy rounded-lg p-3 space-y-1.5">
                        {rt.activeMissions != null && (
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-500">Active Missions</span>
                            <span className={rt.activeMissions > 0 ? 'text-yellow-400 font-medium' : 'text-gray-300'}>{rt.activeMissions}</span>
                          </div>
                        )}
                        {rt.totalTasksCompleted != null && (
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-500">Total Tasks Completed</span>
                            <span className="text-gray-300 font-medium">{rt.totalTasksCompleted}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
      </div>
      </ListState>
    </div>
  )
}
