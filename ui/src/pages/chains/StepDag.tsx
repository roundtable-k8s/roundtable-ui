import { useMemo } from 'react'
import { getKnightConfig } from '../../lib/knights'
import { formatDuration } from '../../lib/format'
import type { ChainStep } from '../../lib/types'
import { loopLabel, skipReasonText } from '../../lib/chains'
import { NodeFanOutBar, fanOutDoneLabel } from './StepViews'

/** Assign each step a column (x) based on topological order of dependencies */
function layoutSteps(steps: ChainStep[]): Map<string, { col: number; row: number }> {
  const stepMap = new Map(steps.map(s => [s.name, s]))
  const columns = new Map<string, number>()

  // Compute column: max(dependsOn columns) + 1, or 0 if no deps
  // A step in a dependency cycle counts as column 0 for the edge that closes the cycle.
  const visiting = new Set<string>()
  function getCol(name: string): number {
    if (columns.has(name)) return columns.get(name)!
    if (visiting.has(name)) return 0
    const step = stepMap.get(name)
    if (!step || !step.dependsOn || step.dependsOn.length === 0) { columns.set(name, 0); return 0 }
    visiting.add(name)
    const maxParent = Math.max(...step.dependsOn.map(d => getCol(d)))
    visiting.delete(name)
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

export function StepDAG({ steps, currentStep }: { steps: ChainStep[]; currentStep: string }) {
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
