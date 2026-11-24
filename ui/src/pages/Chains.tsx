import { apiGet } from '../lib/api'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { ChevronDown, ChevronRight, Clock, Link, Radio, WifiOff, Repeat, ExternalLink } from 'lucide-react'
import { Link as RouterLink, useSearchParams } from 'react-router-dom'
import { getKnightConfig } from '../lib/knights'
import { PageHeader, RefreshButton, PhaseBadge, EmptyState, ErrorBanner } from '../components/ui'
import { formatDuration } from '../lib/format'
import type { Chain, ChainFanOut, ChainItem, ChainLoop, ChainLoopStep, ChainStep } from '../lib/types'
import { sanitizeText } from '../lib/untrusted'
import { useWebSocket } from '../hooks/useWebSocket'
import {
  applyChainUpdate, elapsedLabel, fanOutCounts, formatBytes, heartbeatLabel, loopLabel, loopRounds,
  parseChainUpdate, runningHref, skipReasonText, sortedItems, type ChainUpdate,
} from '../lib/chains'

/** Slow fallback poll, only while the live feed is disconnected. */
export const FALLBACK_POLL_MS = 30_000

/** Assign each step a column (x) based on topological order of dependencies */
function layoutSteps(steps: ChainStep[]): Map<string, { col: number; row: number }> {
  const stepMap = new Map(steps.map(s => [s.name, s]))
  const columns = new Map<string, number>()

  // Compute column: max(dependsOn columns) + 1, or 0 if no deps
  function getCol(name: string): number {
    if (columns.has(name)) return columns.get(name)!
    const step = stepMap.get(name)
    if (!step || !step.dependsOn || step.dependsOn.length === 0) { columns.set(name, 0); return 0 }
    const maxParent = Math.max(...step.dependsOn.map(d => getCol(d)))
    const col = maxParent + 1
    columns.set(name, col)
    return col
  }

  steps.forEach(s => getCol(s.name))

  // Group by column, assign rows within each column
  const colGroups = new Map<number, string[]>()
  for (const [name, col] of columns) {
    if (!colGroups.has(col)) colGroups.set(col, [])
    colGroups.get(col)!.push(name)
  }

  const positions = new Map<string, { col: number; row: number }>()
  for (const [col, names] of colGroups) {
    names.forEach((name, row) => positions.set(name, { col, row }))
  }
  return positions
}

function StepDAG({ steps, currentStep }: { steps: ChainStep[]; currentStep: string }) {
  const positions = useMemo(() => layoutSteps(steps), [steps])
  const maxCol = Math.max(0, ...Array.from(positions.values()).map(p => p.col))
  const maxRow = Math.max(0, ...Array.from(positions.values()).map(p => p.row))

  const nodeW = 180
  const nodeH = 64
  const gapX = 60
  const gapY = 20
  const padX = 20
  const padY = 20

  const svgW = padX * 2 + (maxCol + 1) * nodeW + maxCol * gapX
  const svgH = padY * 2 + (maxRow + 1) * nodeH + maxRow * gapY

  const pos = (col: number, row: number) => ({
    x: padX + col * (nodeW + gapX),
    y: padY + row * (nodeH + gapY),
  })

  const stepMap = new Map(steps.map(s => [s.name, s]))

  return (
    <div className="overflow-x-auto mt-3">
      <svg width={svgW} height={svgH} className="min-w-full">
        {/* Edges */}
        {steps.map(step => {
          const target = positions.get(step.name)
          if (!target) return null
          return (step.dependsOn || []).map(dep => {
            const source = positions.get(dep)
            if (!source) return null
            const s = pos(source.col, source.row)
            const t = pos(target.col, target.row)
            return (
              <line
                key={`${dep}->${step.name}`}
                x1={s.x + nodeW} y1={s.y + nodeH / 2}
                x2={t.x} y2={t.y + nodeH / 2}
                stroke="#4b5563" strokeWidth={2} markerEnd=""
              />
            )
          })
        })}
        {/* Nodes */}
        {steps.map(step => {
          const p = positions.get(step.name)
          if (!p) return null
          const { x, y } = pos(p.col, p.row)
          const cfg = getKnightConfig(step.knight)
          const isRunning = step.phase === 'Running' || step.name === currentStep
          const isSkipped = step.phase === 'Skipped'
          const borderColor = (step.phase === 'Completed' || step.phase === 'Succeeded') ? '#22c55e'
            : step.phase === 'Failed' ? '#ef4444'
            : step.phase === 'PartiallySucceeded' ? '#eab308'
            : isRunning ? '#3b82f6'
            : '#4b5563'

          return (
            <g key={step.name}>
              {isRunning && (
                <rect x={x - 2} y={y - 2} width={nodeW + 4} height={nodeH + 4} rx={10}
                  fill="none" stroke="#3b82f6" strokeWidth={2} opacity={0.6}>
                  <animate attributeName="opacity" values="0.3;0.8;0.3" dur="1.5s" repeatCount="indefinite" />
                </rect>
              )}
              <rect x={x} y={y} width={nodeW} height={nodeH} rx={8}
                fill="#1e293b" stroke={borderColor} strokeWidth={1.5} />
              <text x={x + 10} y={y + 22} fill={isSkipped ? '#6b7280' : '#e5e7eb'}
                fontSize={12} fontWeight={600}
                textDecoration={isSkipped ? 'line-through' : 'none'}>
                {cfg.emoji} {step.name}
              </text>
              <text x={x + 10} y={y + 40} fill="#9ca3af" fontSize={10}>
                {cfg.title} · {formatDuration(step.startTime, step.completionTime)}
              </text>
              <text x={x + 10} y={y + 54} fill={borderColor} fontSize={10}>
                {step.phase}{step.retryCount > 0 ? ` (retry ${step.retryCount})` : ''}
                {step.loop ? ` · ${loopLabel(step.loop)}` : ''}
                {step.fanOut ? ` · ${fanOutDoneLabel(step.fanOut)}` : ''}
              </text>
              {step.fanOut && <NodeFanOutBar fanOut={step.fanOut} x={x + 10} y={y + nodeH - 6} width={nodeW - 20} />}
              {isSkipped && <title>{`Skipped: ${skipReasonText(step)}`}</title>}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function fanOutDoneLabel(f: ChainFanOut): string {
  const c = fanOutCounts(f)
  return `${c.done}/${c.total} done`
}

/** Thin done/running/failed bar along the bottom of a DAG node. */
function NodeFanOutBar({ fanOut, x, y, width }: { fanOut: ChainFanOut; x: number; y: number; width: number }) {
  const c = fanOutCounts(fanOut)
  if (c.total === 0) return null
  const segs: Array<[number, string]> = [[c.done, '#22c55e'], [c.running, '#3b82f6'], [c.failed, '#ef4444'], [c.skipped, '#6b7280']]
  let off = 0
  return (
    <g>
      <rect x={x} y={y} width={width} height={3} rx={1.5} fill="#334155" />
      {segs.map(([n, color], i) => {
        const w = (n / c.total) * width
        const r = <rect key={i} x={x + off} y={y} width={w} height={3} fill={color} />
        off += w
        return n > 0 ? r : null
      })}
    </g>
  )
}

const SEGMENTS: Array<{ key: 'done' | 'running' | 'failed' | 'skipped'; label: string; cls: string }> = [
  { key: 'done', label: 'done', cls: 'bg-green-500' },
  { key: 'running', label: 'running', cls: 'bg-blue-500' },
  { key: 'failed', label: 'failed', cls: 'bg-red-500' },
  { key: 'skipped', label: 'skipped', cls: 'bg-gray-500' },
]

/** Pod / elapsed / heartbeat / activity link for a running task. */
function LiveTaskCells({ t }: { t: ChainItem | ChainLoopStep }) {
  return (
    <>
      <td className="px-2 py-1 font-mono text-gray-300">{t.inFlight?.pod || '—'}</td>
      <td className="px-2 py-1 text-gray-400">{elapsedLabel(t)}</td>
      <td className="px-2 py-1 text-gray-400">{t.phase === 'Running' ? heartbeatLabel(t) : '—'}</td>
      <td className="px-2 py-1">
        {t.phase === 'Running' && t.taskId ? (
          <RouterLink to={runningHref(t.taskId)} className="inline-flex items-center gap-1 text-roundtable-gold hover:underline">
            activity <ExternalLink className="w-3 h-3" />
          </RouterLink>
        ) : null}
      </td>
    </>
  )
}

/** forEach progress bar that expands into the item list. */
export function FanOutProgress({ step }: { step: ChainStep & { fanOut: ChainFanOut } }) {
  const c = fanOutCounts(step.fanOut)
  const items = sortedItems(step.fanOut)
  const [open, setOpen] = useState(step.phase === 'Running')
  const summary = [
    `${c.done} done`, `${c.running} running`, `${c.failed} failed`,
    ...(c.skipped ? [`${c.skipped} skipped`] : []),
    ...(c.pending ? [`${c.pending} pending`] : []),
  ].join(' · ')
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`${step.name} items`}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2 text-xs text-gray-400 mb-1">
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span>{summary} of {c.total}</span>
          {c.omitted > 0 && <span className="text-gray-500">({c.omitted} finished not listed)</span>}
          {step.maxParallel ? <span className="ml-auto text-gray-500">max {step.maxParallel} parallel</span> : null}
        </div>
        <div
          role="progressbar"
          aria-label={`${step.name} progress`}
          aria-valuemin={0}
          aria-valuemax={c.total}
          aria-valuenow={c.done + c.failed + c.skipped}
          className="flex h-2 bg-roundtable-navy rounded-full overflow-hidden"
        >
          {c.total > 0 && SEGMENTS.map(seg => c[seg.key] > 0 && (
            <div key={seg.key} className={seg.cls} style={{ width: `${(c[seg.key] / c.total) * 100}%` }} title={`${c[seg.key]} ${seg.label}`} />
          ))}
        </div>
      </button>
      {open && (
        <table className="w-full text-xs mt-2">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="px-2 py-1 font-normal">#</th>
              <th className="px-2 py-1 font-normal">Phase</th>
              <th className="px-2 py-1 font-normal">Pod</th>
              <th className="px-2 py-1 font-normal">Elapsed</th>
              <th className="px-2 py-1 font-normal">Heartbeat</th>
              <th className="px-2 py-1 font-normal"><span className="sr-only">Activity</span></th>
              <th className="px-2 py-1 font-normal">Output</th>
              <th className="px-2 py-1 font-normal">Error</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.index} className="border-t border-roundtable-steel/30">
                <td className="px-2 py-1 text-gray-300">{item.index}</td>
                <td className="px-2 py-1"><PhaseBadge phase={item.phase} />{item.retries ? <span className="text-yellow-400 ml-1">retry {item.retries}</span> : null}</td>
                <LiveTaskCells t={item} />
                <td className="px-2 py-1 text-gray-400">{item.outputBytes ? formatBytes(item.outputBytes) : '—'}</td>
                <td className="px-2 py-1 text-red-400 max-w-xs truncate" title={item.error ? sanitizeText(item.error) : undefined}>
                  {item.error ? sanitizeText(item.error) : ''}
                </td>
              </tr>
            ))}
            {c.omitted > 0 && (
              <tr className="border-t border-roundtable-steel/30">
                <td colSpan={8} className="px-2 py-1 text-gray-500 italic">
                  {c.omitted} more finished item{c.omitted === 1 ? '' : 's'} not listed
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}

function LoopBodySteps({ steps }: { steps: ChainLoopStep[] }) {
  return (
    <table className="w-full text-xs">
      <tbody>
        {steps.map(s => (
          <tr key={s.name} className="border-t border-roundtable-steel/30">
            <td className="px-2 py-1 text-gray-300">{s.name}</td>
            <td className="px-2 py-1"><PhaseBadge phase={s.phase} /></td>
            <LiveTaskCells t={s} />
            <td className="px-2 py-1 text-red-400 max-w-xs truncate">{s.error ? sanitizeText(s.error) : ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Loop step: "round N/M", the current round's body steps and past rounds. */
export function LoopRounds({ loop }: { loop: ChainLoop }) {
  const rounds = loopRounds(loop)
  const current = rounds.find(r => r.iteration === loop.iteration)
  const past = rounds.filter(r => r !== current)
  return (
    <div>
      <div className="flex items-center gap-2 text-xs mb-1">
        <Repeat className="w-3 h-3 text-roundtable-gold" />
        <span className="text-roundtable-gold font-semibold">{loopLabel(loop)}</span>
        {loop.outcome && <span className="text-gray-400">· {loop.outcome}</span>}
        {loop.onExhausted && <span className="text-gray-500 ml-auto">on exhausted: {loop.onExhausted}</span>}
      </div>
      {current && current.steps.length > 0 && <LoopBodySteps steps={current.steps} />}
      {past.length > 0 && (
        <details className="mt-1">
          <summary className="text-xs text-gray-500 cursor-pointer">Past rounds ({past.length})</summary>
          <ol className="mt-1 space-y-1">
            {past.map(r => (
              <li key={r.iteration} aria-label={`round ${r.iteration}`}>
                <span className="text-xs text-gray-400">Round {r.iteration}</span>
                <LoopBodySteps steps={r.steps} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  )
}

/** Fan-out, loop and skip details for every step that has them. */
function StepProgress({ steps }: { steps: ChainStep[] }) {
  const shown = steps.filter(s => s.fanOut || s.loop || s.phase === 'Skipped')
  if (shown.length === 0) return null
  return (
    <div className="mt-3 space-y-2">
      {shown.map(step => (
        <section key={step.name} aria-label={`step ${step.name}`} className="bg-roundtable-navy border border-roundtable-steel/60 rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-semibold text-white">{getKnightConfig(step.knight).emoji} {step.name}</span>
            <PhaseBadge phase={step.phase} />
          </div>
          {step.phase === 'Skipped' && (
            <p className="text-xs text-gray-400">Skipped: {skipReasonText(step)}</p>
          )}
          {step.loop && <LoopRounds loop={step.loop} />}
          {step.fanOut && <FanOutProgress step={step as ChainStep & { fanOut: ChainFanOut }} />}
        </section>
      ))}
    </div>
  )
}

function StepKVOutput({ chainName, stepName }: { chainName: string; stepName: string }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    apiGet<Record<string, unknown>>(`/api/chains/${chainName}/steps/${stepName}/output`)
      .then(d => setData(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [chainName, stepName])

  if (loading) return <p className="text-xs text-gray-500 mt-2">Loading full output from KV...</p>
  if (error) return null // No KV data yet, that's fine
  if (!data) return null

  const output = (data.output as string) || ''
  const duration = (data.duration as string) || ''

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs text-roundtable-gold uppercase font-semibold">📦 Full Output (NATS KV)</span>
        {duration && <span className="text-xs text-gray-500">⏱ {duration}</span>}
      </div>
      <pre className="text-xs text-gray-300 whitespace-pre-wrap max-h-96 overflow-auto bg-roundtable-navy rounded p-3 border border-roundtable-gold/20">
        {output}
      </pre>
    </div>
  )
}

function StepDetail({ step, chainName }: { step: ChainStep; chainName: string }) {
  const cfg = getKnightConfig(step.knight)
  return (
    <div className="bg-roundtable-navy border border-roundtable-steel rounded-lg p-4 mt-2">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">{cfg.emoji}</span>
        <span className="font-semibold text-white capitalize">{step.name}</span>
        <PhaseBadge phase={step.phase} />
        {step.continueOnFailure && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-yellow-500/20 text-yellow-400 border-yellow-500/30">
            soft fail
          </span>
        )}
        <span className="text-xs text-gray-500 ml-auto">{formatDuration(step.startTime, step.completionTime)}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm mb-3">
        <div><span className="text-gray-500">Knight:</span> <span className="text-gray-300">{step.knight}</span></div>
        <div><span className="text-gray-500">Domain:</span> <span className="text-gray-300">{step.domain}</span></div>
        {step.dependsOn && step.dependsOn.length > 0 && (
          <div className="col-span-2"><span className="text-gray-500">Depends on:</span> <span className="text-gray-300">{step.dependsOn.join(', ')}</span></div>
        )}
        {(step.retryCount > 0 || step.maxRetries) && (
          <div>
            <span className="text-gray-500">Retries:</span> 
            <span className="text-yellow-400 ml-1">
              {step.retryCount > 0 ? `${step.retryCount}` : '0'}
              {step.maxRetries ? `/${step.maxRetries}` : ''}
            </span>
          </div>
        )}
        {step.phase === 'Skipped' && (
          <div className="col-span-2"><span className="text-gray-500">Skipped:</span> <span className="text-gray-300">{skipReasonText(step)}</span></div>
        )}
        {step.outputPath && (
          <div className="col-span-2">
            <span className="text-gray-500">📁 Output path:</span> 
            <span className="text-gray-300 ml-1 font-mono text-xs">{step.outputPath}</span>
          </div>
        )}
      </div>
      {step.result && (
        <div>
          <span className="text-xs text-gray-500 uppercase">Result (truncated)</span>
          <pre className="text-xs text-gray-400 whitespace-pre-wrap max-h-64 overflow-auto mt-1 bg-roundtable-slate rounded p-3 border border-roundtable-steel/50">
            {sanitizeText(step.result)}
          </pre>
        </div>
      )}
      {(step.phase === 'Completed' || step.phase === 'Succeeded') && chainName && (
        <StepKVOutput chainName={chainName} stepName={step.name} />
      )}
    </div>
  )
}

function ChainCard({ chain, focused = false }: { chain: Chain; focused?: boolean }) {
  const [expanded, setExpanded] = useState(focused)
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focused) return
    setExpanded(true)
    cardRef.current?.scrollIntoView?.({ block: 'start' })
  }, [focused])
  const [selectedStep, setSelectedStep] = useState<string | null>(null)

  const activeStep = selectedStep
    ? (chain.steps || []).find(s => s.name === selectedStep) || null
    : null

  return (
    <div ref={cardRef} className={`bg-roundtable-slate border rounded-xl overflow-hidden ${focused ? 'border-roundtable-gold/50' : 'border-roundtable-steel'}`}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-roundtable-steel/30 transition-colors"
      >
        {expanded
          ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
          : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
        <span className="font-semibold text-white">{chain.name}</span>
        <PhaseBadge phase={chain.phase} />
        {chain.suspend && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full border bg-red-500/20 text-red-400 border-red-500/30">
            ⏸ suspended
          </span>
        )}
        {chain.schedule && (
          <span className="text-xs text-gray-500 font-mono">{chain.schedule}</span>
        )}
        {chain.timeoutSeconds && (
          <span className="text-xs text-gray-500">⏱ {chain.timeoutSeconds}s timeout</span>
        )}
        <span className="text-xs text-gray-500">{(chain.steps || []).length} steps</span>
        <span className="ml-auto flex items-center gap-1 text-xs text-gray-500">
          <Clock className="w-3 h-3" />
          {formatDuration(chain.startTime, chain.completionTime)}
        </span>
      </button>
      {expanded && (
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
                <a href={`/missions/${chain.missionRef}`} className="text-blue-400 hover:text-blue-300 ml-1">
                  {chain.missionRef}
                </a>
              </div>
            )}
            {chain.roundTableRef && (
              <div>
                <span className="text-gray-500">Round Table:</span> 
                <a href={`/roundtables/${chain.roundTableRef}`} className="text-blue-400 hover:text-blue-300 ml-1">
                  {chain.roundTableRef}
                </a>
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
          <StepDAG steps={chain.steps || []} currentStep={chain.currentStep} />
          <StepProgress steps={chain.steps || []} />
          {/* Step list for drill-down (#49) */}
          <div className="mt-3 flex flex-wrap gap-2">
            {(chain.steps || []).map(step => {
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

export function ChainsPage() {
  // ?chain=<name> deep link (e.g. from the Running page) expands that chain
  const [searchParams] = useSearchParams()
  const focusChain = searchParams.get('chain') || ''
  const { connected, subscribeTopic } = useWebSocket()
  const [chains, setChains] = useState<Chain[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const abortRef = useRef<AbortController | null>(null)
  // Live updates that arrive while a list fetch is in flight; replayed on
  // top of the (possibly older) snapshot so they aren't lost.
  const pending = useRef<ChainUpdate[] | null>(null)

  const fetchChains = useCallback(() => {
    // Abort any in-flight request (#39)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const replay: ChainUpdate[] = []
    pending.current = replay

    setLoading(true)
    apiGet<Chain[]>('/api/chains', { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return
        setChains(replay.reduce(applyChainUpdate, data || []))
        setError('')
      })
      .catch((e) => {
        // Keep the last good list on transient failures — surface the error instead
        if (e.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Failed to load chains')
      })
      .finally(() => {
        if (controller.signal.aborted) return
        if (pending.current === replay) pending.current = null
        setLoading(false)
      })
  }, [])

  // Live `chain` WS messages (add/update/delete of a Chain)
  useEffect(() => subscribeTopic('chain', (data, msg) => {
    const u = parseChainUpdate(data, msg)
    if (!u) return
    pending.current?.push(u)
    setChains(prev => applyChainUpdate(prev, u))
  }), [subscribeTopic])

  // Fetch on mount and re-sync on every (re)connect, so changes missed
  // while the feed was down are picked up.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current || connected) fetchChains()
    mounted.current = true
  }, [connected, fetchChains])

  // Slow fallback poll only while the live feed is down; paused when hidden (#22)
  useEffect(() => {
    if (connected) return
    let interval: ReturnType<typeof setInterval> | null = null
    const start = () => { if (!interval) interval = setInterval(fetchChains, FALLBACK_POLL_MS) }
    const stop = () => { if (interval) { clearInterval(interval); interval = null } }
    const onVis = () => { document.hidden ? stop() : start() }

    start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [connected, fetchChains])

  // Cleanup abort on unmount
  useEffect(() => () => { abortRef.current?.abort() }, [])

  return (
    <div>
      <PageHeader icon={Link} title="Chain Executions">
        {connected ? (
          <span className="flex items-center gap-1.5 text-xs text-green-400">
            <Radio className="w-3 h-3" />
            Live
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-yellow-400">
            <WifiOff className="w-3 h-3" />
            Live feed disconnected — polling every {FALLBACK_POLL_MS / 1000}s
          </span>
        )}
        <RefreshButton onClick={fetchChains} loading={loading} />
      </PageHeader>

      {error && (
        <div className="mb-6">
          <ErrorBanner>Failed to refresh chains: {error} — showing last known state</ErrorBanner>
        </div>
      )}

      {chains.length === 0 && !loading && (
        <EmptyState icon={Link} title="No chain executions found." />
      )}

      <div className="space-y-3">
        {chains.map(chain => <ChainCard key={`${chain.namespace}/${chain.name}`} chain={chain} focused={chain.name === focusChain} />)}
      </div>
    </div>
  )
}
