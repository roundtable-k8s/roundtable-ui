/**
 * Queue (JetStream backlog) model for the Queues page (#206).
 *
 * KnightQueue mirrors GET /api/queues (#204). History is sampled in the
 * browser from each poll until the server-side ring buffer (#205) lands, so
 * the sparkline covers the time the dashboard has been open.
 */

export interface SequenceInfo {
  consumerSeq: number
  streamSeq: number
  lastActive?: string
}

export interface KnightQueue {
  knight: string
  stream: string
  consumer: string
  /** False when the knight's durable consumer does not exist yet. */
  consumerFound: boolean
  /** Not yet delivered (NumPending). */
  pending: number
  /** Delivered but not yet acked (in flight). */
  ackPending: number
  redelivered: number
  /** Pull requests waiting for messages. */
  waiting: number
  delivered?: SequenceInfo
  ackFloor?: SequenceInfo
  /** Publish time of the oldest unacked message; absent when nothing waits. */
  oldestPendingAt?: string
  oldestWaitSeconds: number
  concurrency: number
  replicas: number
  readyReplicas: number
  /** concurrency × readyReplicas − ackPending, never negative. */
  freeSlots: number
  /** Scaling bounds — present once Knight status.scaling exists (roundtable#250). */
  minReplicas?: number
  maxReplicas?: number
  error?: string
}

/** Oldest-wait badge threshold. */
export const OLDEST_WAIT_WARN_SECONDS = 5 * 60
/** Browser-side history retention, matching the server ring buffer (6 h). */
export const HISTORY_RETENTION_MS = 6 * 60 * 60 * 1000
/** Poll / sample interval, matching the server sampler (15 s). */
export const QUEUE_POLL_MS = 15_000

export interface QueueSample {
  /** Epoch ms. */
  t: number
  pending: number
  ackPending: number
  replicas: number
}

export type QueueHistory = Record<string, QueueSample[]>

export interface ScaleEvent {
  t: number
  from: number
  to: number
  direction: 'up' | 'down'
}

export type QueueWarningKind = 'oldest-wait' | 'saturated' | 'error'

export interface QueueWarning {
  kind: QueueWarningKind
  label: string
  detail: string
}

/**
 * Seconds the oldest message has waited at `now`. Ticks between polls using
 * oldestPendingAt, falling back to the server's oldestWaitSeconds.
 */
export function oldestWait(q: KnightQueue, now: number): number {
  if (q.oldestPendingAt) {
    const at = Date.parse(q.oldestPendingAt)
    if (!Number.isNaN(at)) return Math.max(0, (now - at) / 1000, q.oldestWaitSeconds || 0)
  }
  return Math.max(0, q.oldestWaitSeconds || 0)
}

/** 0 → "—", 42 → "42s", 125 → "2m 5s", 7260 → "2h 1m". */
export function formatWait(seconds: number): string {
  if (!seconds || seconds < 1) return '—'
  const s = Math.floor(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** True when the knight cannot scale further: replicas at a known max. */
export function atMaxReplicas(q: KnightQueue): boolean {
  return q.maxReplicas !== undefined && q.maxReplicas > 0 && q.replicas >= q.maxReplicas
}

/** Warning badges for one knight's queue. */
export function queueWarnings(
  q: KnightQueue,
  now: number,
  thresholdSeconds = OLDEST_WAIT_WARN_SECONDS,
): QueueWarning[] {
  const out: QueueWarning[] = []
  if (q.error) {
    out.push({ kind: 'error', label: 'Unavailable', detail: `Queue could not be read: ${q.error}` })
    return out
  }
  const wait = oldestWait(q, now)
  if (wait >= thresholdSeconds) {
    out.push({
      kind: 'oldest-wait',
      label: `Waiting ${formatWait(wait)}`,
      detail: `Oldest task has waited ${formatWait(wait)} (threshold ${formatWait(thresholdSeconds)})`,
    })
  }
  if (q.pending > 0 && q.freeSlots === 0 && atMaxReplicas(q)) {
    out.push({
      kind: 'saturated',
      label: 'At max, no free slots',
      detail: `${q.pending} pending with 0 free slots and replicas at max (${q.replicas}/${q.maxReplicas})`,
    })
  }
  return out
}

/**
 * Append one sample per knight at `now` and drop samples older than the
 * retention window. Knights whose queue could not be read are skipped.
 * Returns a new object; the input is not mutated.
 */
export function appendSamples(
  history: QueueHistory,
  queues: KnightQueue[],
  now: number,
  retentionMs = HISTORY_RETENTION_MS,
): QueueHistory {
  const cutoff = now - retentionMs
  const next: QueueHistory = {}
  for (const [knight, samples] of Object.entries(history)) {
    const kept = samples.filter(s => s.t >= cutoff)
    if (kept.length) next[knight] = kept
  }
  for (const q of queues) {
    if (q.error) continue
    const prev = next[q.knight] ?? []
    // Two samples closer than 1 s are the same poll seen twice (StrictMode).
    if (prev.length && now - prev[prev.length - 1].t < 1000) continue
    next[q.knight] = [...prev, { t: now, pending: q.pending, ackPending: q.ackPending, replicas: q.replicas }]
  }
  return next
}

/** Replica-count changes between consecutive samples. */
export function scaleEvents(samples: QueueSample[]): ScaleEvent[] {
  const out: ScaleEvent[] = []
  for (let i = 1; i < samples.length; i++) {
    const from = samples[i - 1].replicas
    const to = samples[i].replicas
    if (from !== to) out.push({ t: samples[i].t, from, to, direction: to > from ? 'up' : 'down' })
  }
  return out
}

/**
 * Per-knight Grafana link: the configured dashboard URL with var-knight set.
 * Returns null unless base is an absolute http(s) URL.
 */
export function grafanaKnightUrl(base: string | undefined, knight?: string): string | null {
  if (!base) return null
  let u: URL
  try {
    u = new URL(base)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (knight) u.searchParams.set('var-knight', knight)
  return u.toString()
}
