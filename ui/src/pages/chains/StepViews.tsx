import { useState, Fragment } from 'react'
import { ChevronDown, ChevronRight, Repeat, ExternalLink } from 'lucide-react'
import { UntrustedText } from '../../components/UntrustedText'
import { Link as RouterLink } from 'react-router-dom'
import { getKnightConfig } from '../../lib/knights'
import { PhaseBadge } from '../../components/ui'
import type { ChainFanOut, ChainItem, ChainLoop, ChainLoopStep, ChainStep } from '../../lib/types'
import { sanitizeText } from '../../lib/untrusted'
import { elapsedLabel, fanOutCounts, formatBytes, heartbeatLabel, loopLabel, loopRounds, roundFailed, runningHref, skipReasonText, sortedItems } from '../../lib/chains'

export function fanOutDoneLabel(f: ChainFanOut): string {
  const c = fanOutCounts(f)
  return `${c.done}/${c.total} done`
}

/** Thin done/running/failed bar along the bottom of a DAG node. */
export function NodeFanOutBar({ fanOut, x, y, width }: { fanOut: ChainFanOut; x: number; y: number; width: number }) {
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
        <table aria-label={`${step.name} items`} className="w-full text-xs mt-2">
          <thead>
            <tr className="text-gray-500 text-left">
              <th scope="col" className="px-2 py-1 font-normal">#</th>
              <th scope="col" className="px-2 py-1 font-normal">Phase</th>
              <th scope="col" className="px-2 py-1 font-normal">Pod</th>
              <th scope="col" className="px-2 py-1 font-normal">Elapsed</th>
              <th scope="col" className="px-2 py-1 font-normal">Heartbeat</th>
              <th scope="col" className="px-2 py-1 font-normal"><span className="sr-only">Activity</span></th>
              <th scope="col" className="px-2 py-1 font-normal">Output</th>
              <th scope="col" className="px-2 py-1 font-normal">Error</th>
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
    <table aria-label="Loop body steps" className="w-full text-xs">
      <tbody>
        {steps.map(s => (
          <Fragment key={`${s.name}-${s.taskId ?? ''}`}>
            <tr className="border-t border-roundtable-steel/30">
              <td className="px-2 py-1 text-gray-300">{s.name}</td>
              <td className="px-2 py-1"><PhaseBadge phase={s.phase} /></td>
              <LiveTaskCells t={s} />
            </tr>
            {(s.error || s.outputSummary) && (
              <tr>
                <td colSpan={6} className="px-2 pb-1">
                  {s.error && <UntrustedText as="pre" text={s.error} className="whitespace-pre-wrap text-red-400" collapseAfter={1000} />}
                  {s.outputSummary && <UntrustedText as="pre" text={s.outputSummary} className="whitespace-pre-wrap text-gray-400" collapseAfter={1000} />}
                </td>
              </tr>
            )}
          </Fragment>
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
                {roundFailed(r) && <span className="ml-2 text-xs text-red-400 font-semibold">failed</span>}
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
export function StepProgress({ steps }: { steps: ChainStep[] }) {
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
