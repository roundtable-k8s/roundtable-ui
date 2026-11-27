import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Target, Clock, Users, Link2, DollarSign, FileText, Brain, ChevronDown, ChevronUp, Hash } from 'lucide-react'
import type { Mission } from '../hooks/useMissions'
import { MissionPhaseBadge } from './MissionPhaseBadge'
import { PlanningResultViewer } from './PlanningResultViewer'
import { getKnightConfig } from '../lib/knights'
import { MissionResults, KnightStatusList, ChainStatusList } from './MissionSections'
import { formatRelativeTime, formatCost } from '../lib/format'
import { Spinner, TableBadge } from './ui'
import { TraceLink } from './TraceLink'
import { CostTag } from './CostTag'
import { tokensText } from '../lib/cost'

interface MissionCardProps {
  /** Show the table badge (when every table is listed together). */
  showTable?: boolean
  mission: Mission
  onClick?: () => void
  /** Detail page URL; makes the name a real link (keyboard reachable, middle-clickable). */
  href?: string
}

export function MissionCard({ mission, onClick, showTable, href }: MissionCardProps) {
  // Meta-missions start with no knights/chains — the API serializes those
  // nil slices as null
  const knights = mission.knights ?? []
  const chains = mission.chains ?? []
  const [showResults, setShowResults] = useState(false)
  const [showKnights, setShowKnights] = useState(false)
  const [showChains, setShowChains] = useState(false)
  const [showCriteria, setShowCriteria] = useState(false)
  const [showBriefing, setShowBriefing] = useState(false)
  
  // CleaningUp is finished work being torn down; count it only once the
  // operator has stamped completedAt, otherwise it may still be running.
  const isComplete = mission.phase === 'Succeeded' || mission.phase === 'Failed' || mission.phase === 'Expired' ||
    (mission.phase === 'CleaningUp' && !!mission.completedAt)
  const isPlanning = mission.phase === 'Planning'
  
  // Calculate budget usage percentage
  const budget = parseFloat(mission.costBudgetUSD) || 0
  const cost = parseFloat(mission.totalCost) || 0
  const budgetPercent = budget > 0 ? Math.min((cost / budget) * 100, 100) : 0
  const budgetColor = budgetPercent > 90 ? 'text-red-400' : budgetPercent > 70 ? 'text-yellow-400' : 'text-green-400'

  return (
    <div
      onClick={onClick}
      className={`bg-roundtable-slate border border-roundtable-steel rounded-xl p-5 hover:border-roundtable-gold/30 transition-all${onClick ? ' cursor-pointer' : ''} group`}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <Target className="w-5 h-5 text-roundtable-gold" />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-white">
                {href
                  ? <Link to={href} onClick={(e) => e.stopPropagation()} className="hover:text-roundtable-gold focus:outline-none focus-visible:underline">{mission.name}</Link>
                  : mission.name}
              </h3>
              {showTable && <TableBadge table={mission.table} />}
              {mission.metaMission && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400 border border-purple-500/30 flex items-center gap-1">
                  <Brain className="w-3 h-3" />
                  Meta
                </span>
              )}
            </div>
            <p className="text-sm text-gray-400 line-clamp-1">{mission.objective}</p>
          </div>
        </div>
        <MissionPhaseBadge phase={mission.phase} />
      </div>

      {/* Planning Status - show spinner while planning */}
      {isPlanning && (
        <div className="mb-3 bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <Spinner size="sm" />
            <span className="font-medium">Planner generating execution plan...</span>
          </div>
          <p className="text-xs text-gray-400 mt-1">
            The AI planner is reasoning about chains, knights, tools, and skills needed.
          </p>
        </div>
      )}

      {/* Planning Results - show after planning completes */}
      {mission.planningResult && !isPlanning && (
        <div className="mb-3">
          <PlanningResultViewer result={mission.planningResult} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Knights */}
        <div className="bg-roundtable-navy/50 rounded-lg p-2">
          <div className="flex items-center gap-2 mb-1">
            <Users className="w-3 h-3 text-gray-400" />
            <span className="text-xs text-gray-400">Knights</span>
          </div>
          <div className="flex gap-1">
            {knights.slice(0, 3).map((knight) => {
              const config = getKnightConfig(knight)
              return (
                <span key={knight} className="text-sm" title={knight}>
                  {config.emoji}
                </span>
              )
            })}
            {knights.length > 3 && (
              <span className="text-xs text-gray-500">+{knights.length - 3}</span>
            )}
          </div>
        </div>

        {/* Chains */}
        <div className="bg-roundtable-navy/50 rounded-lg p-2">
          <div className="flex items-center gap-2 mb-1">
            <Link2 className="w-3 h-3 text-gray-400" />
            <span className="text-xs text-gray-400">Chains</span>
          </div>
          <span className="text-sm text-white font-mono">{chains.length}</span>
        </div>
      </div>

      {/* Timing & Cost */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1 text-gray-500">
          <Clock className="w-3 h-3" />
          {isComplete && mission.completedAt ? (
            <span>Completed {formatRelativeTime(mission.completedAt)}</span>
          ) : isComplete ? (
            <span>Finished (time unknown)</span>
          ) : mission.startedAt ? (
            <span>Started {formatRelativeTime(mission.startedAt)}</span>
          ) : (
            <span>Not started</span>
          )}
        </div>
        {mission.costBudgetUSD && parseFloat(mission.costBudgetUSD) > 0 && (
          <div className="flex items-center gap-1">
            <DollarSign className={`w-3 h-3 ${budgetColor}`} />
            <span className={budgetColor}>
              {formatCost(cost)} / {formatCost(budget)}
            </span>
          </div>
        )}
      </div>
      {mission.traceId && <div className="mt-2 text-xs"><TraceLink traceId={mission.traceId} /></div>}
      <div className="flex items-center justify-between text-xs mt-2" aria-label="mission cost">
        <div className="flex items-center gap-1 text-gray-500">
          <DollarSign className="w-3 h-3" />
          <span>Cost</span>
          <CostTag costUSD={mission.totalCost} notionalUSD={mission.notionalCostUSD} className="text-gray-300" />
        </div>
        <div className="flex items-center gap-1 text-gray-500">
          <Hash className="w-3 h-3" />
          <span>Tokens</span>
          <span className="text-gray-300">{tokensText(mission.tokens)}</span>
        </div>
      </div>

      {/* Knights Statuses */}
      {mission.knightStatuses && mission.knightStatuses.length > 0 && (
        <div className="mt-3 pt-3 border-t border-roundtable-steel/50">
          <button
            onClick={(e) => { e.stopPropagation(); setShowKnights(!showKnights) }}
            aria-expanded={showKnights}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-300 transition-colors mb-2 w-full"
          >
            {showKnights ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <Users className="w-3 h-3" />
            <span className="font-medium">Knights ({mission.knightStatuses.length})</span>
          </button>
          {showKnights && (
            <KnightStatusList statuses={mission.knightStatuses} />
          )}
        </div>
      )}

      {/* Chain Statuses */}
      {mission.chainStatuses && mission.chainStatuses.length > 0 && (
        <div className="mt-3 pt-3 border-t border-roundtable-steel/50">
          <button
            onClick={(e) => { e.stopPropagation(); setShowChains(!showChains) }}
            aria-expanded={showChains}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-300 transition-colors mb-2 w-full"
          >
            {showChains ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <Link2 className="w-3 h-3" />
            <span className="font-medium">Chains ({mission.chainStatuses.length})</span>
          </button>
          {showChains && (
            <ChainStatusList statuses={mission.chainStatuses} />
          )}
        </div>
      )}

      {/* Success Criteria */}
      {mission.successCriteria && (
        <div className="mt-3 pt-3 border-t border-roundtable-steel/50">
          <button
            onClick={(e) => { e.stopPropagation(); setShowCriteria(!showCriteria) }}
            aria-expanded={showCriteria}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-300 transition-colors mb-2 w-full"
          >
            {showCriteria ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <Target className="w-3 h-3" />
            <span className="font-medium">Success Criteria</span>
          </button>
          {showCriteria && (
            <div className="bg-roundtable-navy/50 rounded-lg p-3 border border-green-500/20">
              <p className="text-xs text-gray-300 whitespace-pre-wrap">{mission.successCriteria}</p>
            </div>
          )}
        </div>
      )}

      {/* Briefing */}
      {mission.briefing && (
        <div className="mt-3 pt-3 border-t border-roundtable-steel/50">
          <button
            onClick={(e) => { e.stopPropagation(); setShowBriefing(!showBriefing) }}
            aria-expanded={showBriefing}
            className="flex items-center gap-2 text-xs text-gray-400 hover:text-gray-300 transition-colors mb-2 w-full"
          >
            {showBriefing ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            <FileText className="w-3 h-3" />
            <span className="font-medium">Briefing</span>
          </button>
          {showBriefing && (
            <div className="bg-roundtable-navy/50 rounded-lg p-3 border border-blue-500/20">
              <p className="text-xs text-gray-300 whitespace-pre-wrap">{mission.briefing}</p>
            </div>
          )}
        </div>
      )}

      {/* RoundTable */}
      <div className="mt-3 pt-3 border-t border-roundtable-steel/50 flex items-center justify-between">
        <span className="text-xs text-gray-500">
          RoundTable: <span className="text-gray-400">{mission.roundTableRef}</span>
        </span>
        <div className="flex items-center gap-2">
          {isComplete && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowResults(r => !r) }}
              aria-expanded={showResults}
              className="flex items-center gap-1 text-xs text-roundtable-gold/60 hover:text-roundtable-gold transition-colors"
            >
              <FileText className="w-3 h-3" />
              {showResults ? 'hide results' : 'results'}
            </button>
          )}
          {onClick && (
            <span className="text-xs text-gray-600 group-hover:text-roundtable-gold/60 transition-colors">
              view details →
            </span>
          )}
        </div>
      </div>

      {showResults && (
        <div className="mt-3 pt-3 border-t border-roundtable-steel/50">
          <MissionResults name={mission.name} />
        </div>
      )}
    </div>
  )
}
