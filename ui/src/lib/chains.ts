/**
 * Chain view helpers: fan-out progress, loop rounds, skip reasons and the
 * `chain` WebSocket message (envelope `op` + ChainSummary `data`).
 */
import type { Chain, ChainFanOut, ChainItem, ChainLoop, ChainLoopRound, ChainStep, ChainTaskLive } from './types'

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

/** Human-readable reason for a skipped step. */
export function skipReasonText(step: Pick<ChainStep, 'skipReason' | 'when'>): string {
  switch (step.skipReason) {
    case 'WhenFalse':
      return step.when ? `when condition was false: ${step.when}` : 'when condition was false'
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

export function loopLabel(loop: ChainLoop): string {
  return loop.maxIterations ? `round ${loop.iteration}/${loop.maxIterations}` : `round ${loop.iteration}`
}

function shortDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** Elapsed run time: from startTime when known (stays live), else the API's snapshot. */
export function elapsedLabel(t: ChainTaskLive, now = Date.now()): string {
  if (t.startTime) {
    const end = t.completionTime ? new Date(t.completionTime).getTime() : now
    return shortDuration((end - new Date(t.startTime).getTime()) / 1000)
  }
  return t.elapsedSeconds !== undefined ? shortDuration(t.elapsedSeconds) : '—'
}

export function heartbeatLabel(t: ChainTaskLive): string {
  return t.heartbeatAgeSeconds !== undefined ? `${shortDuration(t.heartbeatAgeSeconds)} ago` : '—'
}

/** Deep link to a task's live activity on the Running page. */
export function runningHref(taskId: string): string {
  return `/running?task=${encodeURIComponent(taskId)}`
}

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

const chainKey = (c: { name: string; namespace: string }) => `${c.namespace}/${c.name}`

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
