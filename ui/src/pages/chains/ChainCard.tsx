import { useState, useEffect, useRef } from 'react'
import { ChevronDown, ChevronRight, Clock } from 'lucide-react'
import { Link as RouterLink } from 'react-router-dom'
import { getKnightConfig } from '../../lib/knights'
import { PhaseBadge, Badge } from '../../components/ui'
import { formatDuration, formatRelativeTime, until } from '../../lib/format'
import type { Chain } from '../../lib/types'
import { TraceLink } from '../../components/TraceLink'
import { RunNow } from '../../components/RunNow'
import { CostTag } from '../../components/CostTag'
import { RunCostTable } from '../../components/RunCostTable'
import { ChainTimeline } from '../../components/ChainTimeline'
import { isTerminalPhase, scheduleSummary } from '../../lib/chains'
import { StepDAG } from './StepDag'
import { StepProgress } from './StepViews'
import { StepDetail } from './StepDetail'
import { useChainDetail } from './useChainDetail'
import { CancelRun } from './CancelRun'

export function ChainCard({ chain, focused = false }: { chain: Chain; focused?: boolean }) {
  const [expanded, setExpanded] = useState(focused)
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focused) return
    setExpanded(true)
    cardRef.current?.scrollIntoView?.({ block: 'start' })
  }, [focused])
  const [selectedStep, setSelectedStep] = useState<string | null>(null)
  const [showTimeline, setShowTimeline] = useState(false)
  const { view, error: detailError } = useChainDetail(chain, expanded)
  const steps = view?.steps || []

  const activeStep = selectedStep
    ? steps.find(s => s.name === selectedStep) || null
    : null

  return (
    <div ref={cardRef} className={`bg-roundtable-slate border rounded-xl overflow-hidden ${focused ? 'border-roundtable-gold/50' : 'border-roundtable-steel'}`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-4 text-left hover:bg-roundtable-steel/30 transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
          : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
        <span className="font-semibold text-white">{chain.name}</span>
        <PhaseBadge phase={chain.phase} />
        {chain.suspend && (
          <Badge tone="red" strength="strong" className="font-medium">⏸ suspended</Badge>
        )}
        {chain.schedule && (
          <span data-testid="scheduled-badge" className="text-xs font-medium px-2 py-0.5 rounded-full border bg-roundtable-gold/10 text-roundtable-gold border-roundtable-gold/30">
            Scheduled
          </span>
        )}
        {chain.schedule && (
          <span className="text-xs text-gray-500 font-mono">
            {chain.schedule}{chain.timeZone ? ` ${chain.timeZone}` : ''}
          </span>
        )}
        {chain.schedule && (
          <span data-testid="schedule-summary" className="text-xs text-gray-400">
            {scheduleSummary(chain, until, formatRelativeTime)}
            {chain.runsCompleted ? ` · ${chain.runsCompleted} runs` : ''}
          </span>
        )}
        {chain.timeoutSeconds && (
          <span className="text-xs text-gray-500">⏱ {chain.timeoutSeconds}s timeout</span>
        )}
        <span className="text-xs text-gray-500">{(chain.steps || []).length} steps</span>
        {chain.costUSD && (
          <CostTag costUSD={chain.costUSD} notionalUSD={chain.notionalCostUSD} className="text-xs text-roundtable-gold" />
        )}
        <span className="ml-auto flex items-center gap-1 text-xs text-gray-500">
          <Clock className="w-3 h-3" />
          {formatDuration(chain.startTime, chain.completionTime)}
        </span>
      </button>
      {expanded && !view && (
        <div className="px-5 py-3 border-t border-roundtable-steel/50 text-xs">
          {detailError
            ? <span className="text-red-400">Failed to load chain: {detailError}</span>
            : <span className="text-gray-500">Loading chain…</span>}
        </div>
      )}
      {expanded && view && (
        <div className="px-5 pb-4 border-t border-roundtable-steel/50">
          {/* Description */}
          {chain.description && (
            <div className="mt-3 mb-2">
              <span className="text-xs text-gray-500 uppercase font-semibold">Description</span>
              <p className="text-sm text-gray-300 mt-1">{chain.description}</p>
            </div>
          )}
          
          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-3 text-sm mt-3 mb-3">
            {chain.missionRef && (
              <div>
                <span className="text-gray-500">Mission:</span> 
                <RouterLink to={`/missions/${encodeURIComponent(chain.missionRef)}`} className="text-blue-400 hover:text-blue-300 ml-1">
                  {chain.missionRef}
                </RouterLink>
              </div>
            )}
            {chain.roundTableRef && (
              <div>
                <span className="text-gray-500">Round Table:</span> 
                <RouterLink to={`/roundtables?table=${encodeURIComponent(chain.roundTableRef)}`} className="text-blue-400 hover:text-blue-300 ml-1">
                  {chain.roundTableRef}
                </RouterLink>
              </div>
            )}
            {chain.outputKnightRef && (
              <div>
                <span className="text-gray-500">Output Knight:</span> 
                <span className="text-gray-300 ml-1">{chain.outputKnightRef}</span>
              </div>
            )}
            {(chain.runsCompleted !== undefined || chain.runsFailed !== undefined) && (
              <div>
                <span className="text-gray-500">Run History:</span> 
                <span className="text-green-400 ml-1">{chain.runsCompleted || 0} ✓</span>
                <span className="text-red-400 ml-1">{chain.runsFailed || 0} ✗</span>
              </div>
            )}
          </div>
          {view.traceId && <div className="mb-2"><TraceLink traceId={view.traceId} /></div>}
          {chain.invokable && !chain.missionRef && !chain.runTemplate && <RunNow chain={chain.name} namespace={chain.namespace} />}
          {chain.runTemplate && !isTerminalPhase(chain.phase) && <CancelRun chain={chain} />}
          <StepDAG steps={steps} currentStep={view.currentStep} />
          <StepProgress steps={steps} />
          {steps.length > 0 && <RunCostTable chain={view} />}
          {steps.length > 0 && (
            <div className="mt-3">
              <button type="button" aria-expanded={showTimeline} onClick={() => setShowTimeline(v => !v)}
                className="text-xs text-gray-400 hover:text-white flex items-center gap-1">
                {showTimeline ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                Timeline
              </button>
              {showTimeline && (
                <div className="mt-2">
                  <ChainTimeline chain={view} selected={selectedStep}
                    onSelect={name => setSelectedStep(selectedStep === name ? null : name)} />
                </div>
              )}
            </div>
          )}
          {/* Step list for drill-down (#49) */}
          <div className="mt-3 flex flex-wrap gap-2">
            {steps.map(step => {
              const cfg = getKnightConfig(step.knight)
              return (
                <button key={step.name}
                  onClick={() => setSelectedStep(selectedStep === step.name ? null : step.name)}
                  className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                    selectedStep === step.name
                      ? 'bg-roundtable-gold/20 border-roundtable-gold/30 text-roundtable-gold'
                      : 'border-roundtable-steel text-gray-400 hover:text-white hover:border-gray-500'
                  }`}>
                  {cfg.emoji} {step.name}
                </button>
              )
            })}
          </div>
          {activeStep && <StepDetail step={activeStep} chainName={chain.name} />}
        </div>
      )}
    </div>
  )
}
