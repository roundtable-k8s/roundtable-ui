/**
 * Chain view helpers: fan-out progress, loop rounds, skip reasons and the
 * `chain` WebSocket message (envelope `op` + ChainSummary `data`).
 */
import type { Chain, ChainFanOut, ChainItem, ChainLoop, ChainLoopRound, ChainRunGroup, ChainStep, ChainTaskLive } from './types'
import { formatRelativeTime, formatSecondsLadder } from './format'
import { namespacedKey } from './keys'
import { runningHref } from './links'

export interface FanOutCounts {
  total: number
  done: number
  running: number
  failed: number
  skipped: number
  pending: number
  omitted: number
}

const isDone = (p: string) => p === 'Succeeded' || p === 'Completed'

/**
 * Item counts for a fan-out. Uses the operator's counters (which cover every
 * item, listed or omitted) and falls back to counting the listed items.
 */
export function fanOutCounts(f: ChainFanOut): FanOutCounts {
  const items = f.items || []
  const count = (pred: (p: string) => boolean) => items.filter(i => pred(i.phase)).length
  const hasCounters = [f.pending, f.running, f.succeeded, f.failed, f.skipped].some(v => v !== undefined)
  const done = hasCounters ? f.succeeded ?? 0 : count(isDone)
  const running = hasCounters ? f.running ?? 0 : count(p => p === 'Running')
  const failed = hasCounters ? f.failed ?? 0 : count(p => p === 'Failed')
  const skipped = hasCounters ? f.skipped ?? 0 : count(p => p === 'Skipped')
  const total = Math.max(f.total || 0, items.length + (f.omittedItems || 0))
  const pending = hasCounters && f.pending !== undefined
    ? f.pending
    : Math.max(0, total - done - running - failed - skipped)
  return { total, done, running, failed, skipped, pending, omitted: f.omittedItems || 0 }
}

/** Listed items: in-flight first, then failed, then the rest, each by index. */
export function sortedItems(f: ChainFanOut): ChainItem[] {
  const rank = (p: string) => (p === 'Running' ? 0 : p === 'Failed' ? 1 : p === 'Pending' ? 3 : 2)
  return [...(f.items || [])].sort((a, b) => rank(a.phase) - rank(b.phase) || a.index - b.index)
}

/** Chain phases the operator never leaves (ChainPhase: Succeeded, Failed, PartiallySucceeded). */
export const TERMINAL_PHASES: readonly string[] = ['Succeeded', 'Failed', 'PartiallySucceeded']

export function isTerminalPhase(phase: string | undefined): boolean {
  return !!phase && TERMINAL_PHASES.includes(phase)
}

/** Human-readable reason for a skipped step. */
export function skipReasonText(step: Pick<ChainStep, 'skipReason' | 'when' | 'skipMessage'>): string {
  if (step.skipMessage) return step.skipMessage
  switch (step.skipReason) {
    case 'WhenFalse':
      return step.when ? `when evaluated to false: ${step.when}` : 'when evaluated to false'
    case 'ChainFailed':
      return 'the chain failed before this step ran'
    case undefined:
    case '':
      return step.when ? `when: ${step.when}` : 'no reason reported'
    default:
      return step.skipReason
  }
}

/** Rounds newest first; the current round is the one matching `iteration`. */
export function loopRounds(loop: ChainLoop): ChainLoopRound[] {
  return [...(loop.rounds || [])].sort((a, b) => b.iteration - a.iteration)
}

/** True when any body step of the round failed (or carries an error). */
export function roundFailed(round: ChainLoopRound): boolean {
  return round.steps.some(s => s.phase === 'Failed' || !!s.error)
}

export function loopLabel(loop: ChainLoop): string {
  return loop.maxIterations ? `round ${loop.iteration}/${loop.maxIterations}` : `round ${loop.iteration}`
}

function shortDuration(sec: number): string {
  return formatSecondsLadder(Math.max(0, sec))
}

/** Elapsed run time: from startTime when known (stays live), else the API's snapshot. */
export function elapsedLabel(t: ChainTaskLive, now = Date.now()): string {
  if (t.startTime) {
    const end = t.completionTime ? new Date(t.completionTime).getTime() : now
    return shortDuration((end - new Date(t.startTime).getTime()) / 1000)
  }
  const ms = t.inFlight?.elapsedMs
  return ms !== undefined ? shortDuration(ms / 1000) : '—'
}

export function heartbeatLabel(t: ChainTaskLive): string {
  const ms = t.inFlight?.heartbeatAgeMs
  return ms !== undefined ? `${shortDuration(ms / 1000)} ago` : '—'
}

export { runningHref }

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export type ChainUpdate =
  | { op: 'upsert'; chain: Chain }
  | { op: 'delete'; name: string; namespace: string }

/** Parse a `chain` WS message (data = ChainSummary, envelope op = upsert|delete). */
export function parseChainUpdate(data: unknown, msg?: Record<string, unknown>): ChainUpdate | null {
  if (!data || typeof data !== 'object') return null
  const c = data as Partial<Chain>
  if (typeof c.name !== 'string' || !c.name) return null
  const namespace = typeof c.namespace === 'string' ? c.namespace : ''
  if (msg?.op === 'delete') return { op: 'delete', name: c.name, namespace }
  return { op: 'upsert', chain: { ...(c as Chain), namespace } }
}

const chainKey = namespacedKey

/** Apply a live update to the list, keeping order (new chains append). */
export function applyChainUpdate(chains: Chain[], u: ChainUpdate): Chain[] {
  if (u.op === 'delete') {
    const key = chainKey(u)
    const next = chains.filter(c => chainKey(c) !== key)
    return next.length === chains.length ? chains : next
  }
  const key = chainKey(u.chain)
  const i = chains.findIndex(c => chainKey(c) === key)
  if (i < 0) return [...chains, u.chain]
  const next = chains.slice()
  next[i] = u.chain
  return next
}

/** Insert or replace a chain, putting new ones first (run copies are newest first). */
export function upsertNewestFirst(chains: Chain[], chain: Chain): Chain[] {
  const key = chainKey(chain)
  const i = chains.findIndex(c => chainKey(c) === key)
  if (i < 0) return [chain, ...chains]
  const next = chains.slice()
  next[i] = chain
  return next
}

/** Merge a page of chains into a list, replacing known ones, keeping order. */
export function appendPage(chains: Chain[], page: Chain[]): Chain[] {
  const seen = new Set(chains.map(chainKey))
  return [...chains, ...page.filter(c => !seen.has(chainKey(c)))]
}

const PHASE_RANK = ['Running', 'StepRunning', 'Pending', 'Succeeded', 'PartiallySucceeded', 'Failed']

/** "PartiallySucceeded" → "partially succeeded" */
export function phaseWords(phase: string): string {
  return phase.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

/** "pr-pipeline: 150 runs, 148 succeeded, 1 partially succeeded, last 33m ago" */
export function runGroupSummary(g: ChainRunGroup): string {
  const rank = (p: string) => {
    const i = PHASE_RANK.indexOf(p)
    return i < 0 ? PHASE_RANK.length : i
  }
  const phases = Object.entries(g.phases || {})
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([p, n]) => `${n} ${phaseWords(p)}`)
  const parts = [`${g.runs} run${g.runs === 1 ? '' : 's'}`, ...phases]
  if (g.lastStartTime) parts.push(`last ${formatRelativeTime(g.lastStartTime)}`)
  return `${g.template}: ${parts.join(', ')}`
}

/** Scheduled chains first (soonest next run first); others keep their order. */
export function sortScheduledFirst(chains: Chain[]): Chain[] {
  const when = (c: Chain) => (c.nextScheduledAt ? new Date(c.nextScheduledAt).getTime() : Infinity)
  return chains
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const sa = a.c.schedule ? 0 : 1
      const sb = b.c.schedule ? 0 : 1
      if (sa !== sb) return sa - sb
      if (sa === 0 && when(a.c) !== when(b.c)) return when(a.c) < when(b.c) ? -1 : 1
      return a.i - b.i
    })
    .map(x => x.c)
}

/** "11:00 UTC" for a next run, in the browser's locale and the chain's zone. */
export function nextRunClock(c: Chain): string {
  if (!c.nextScheduledAt) return ''
  const zone = c.timeZone || 'UTC'
  try {
    const t = new Date(c.nextScheduledAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: zone })
    return `${t} ${zone}`
  } catch {
    return zone
  }
}

/** One-line schedule status: "next in 14h (11:00 UTC) · last ran 3h ago". */
export function scheduleSummary(c: Chain, until: (iso?: string) => string, ago: (iso: string | null) => string): string {
  if (!c.schedule) return ''
  const parts: string[] = []
  if (c.suspend) parts.push('suspended')
  else if (c.nextScheduledAt) parts.push(`next ${until(c.nextScheduledAt)} (${nextRunClock(c)})`)
  if (c.lastScheduledAt) parts.push(`last ran ${ago(c.lastScheduledAt)}`)
  return parts.join(' · ')
}
