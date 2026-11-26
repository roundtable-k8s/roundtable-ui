import { formatSecondsLadder } from './format'
/**
 * Types and pure helpers for the Queues page (#185 / #206).
 *
 * Data comes from two API endpoints:
 *   GET /api/queues          live JetStream consumer info per knight (#204)
 *   GET /api/queues/history  15 s samples (6 h ring buffer) + scale events (#205)
 */

export interface SequencePair {
  consumerSeq: number
  streamSeq: number
  lastActive?: string
}

/** One knight's live queue, from GET /api/queues. */
export interface KnightQueue {
  /** RoundTable the object belongs to; "none" when unset. List endpoints accept ?table=<name>. */
  table?: string
  knight: string
  stream: string
  consumer: string
  consumerFound: boolean
  pending: number
  ackPending: number
  redelivered: number
  waiting: number
  delivered: SequencePair
  ackFloor: SequencePair
  oldestPendingAt?: string
  oldestWaitSeconds: number
  concurrency: number
  replicas: number
  readyReplicas: number
  freeSlots: number
  error?: string
}

/** One 15 s sample. Queue fields are null when the consumer could not be read. */
export interface QueueSample {
  t: string
  pending: number | null
  ackPending: number | null
  redelivered: number | null
  waiting: number | null
  replicas: number
  readyReplicas: number
  desiredReplicas?: number
  maxReplicas?: number
}

export interface ScaleEvent {
  t: string
  direction: 'up' | 'down' | string
  from?: number
  to: number
  reason: string
  k8sReason?: string
  source: 'hpa' | 'keda' | 'sample' | string
  object?: string
}

/** One knight's history, from GET /api/queues/history. */
export interface KnightQueueHistory {
  knight: string
  intervalSeconds: number
  retentionSeconds: number
  samples: QueueSample[]
  events: ScaleEvent[]
  grafanaUrl?: string
}

/** Oldest wait above this raises a warning badge. */
export const OLDEST_WAIT_WARN_SECONDS = 5 * 60

/** Compact wait duration: 45s, 3m 20s, 1h 5m; zero or less is "—". */
export function formatWait(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  return formatSecondsLadder(Math.floor(seconds))
}

/** The most recent known max replica count from a knight's history. */
export function latestMaxReplicas(history?: KnightQueueHistory): number | undefined {
  if (!history) return undefined
  for (let i = history.samples.length - 1; i >= 0; i--) {
    const m = history.samples[i].maxReplicas
    if (m != null) return m
  }
  return undefined
}

export type QueueWarningKind = 'oldest-wait' | 'saturated'

export interface QueueWarning {
  kind: QueueWarningKind
  label: string
  detail: string
}

/**
 * Warnings for one knight:
 *  - oldest-wait: the oldest pending task has waited longer than the threshold.
 *  - saturated:   tasks are pending, there are no free slots and replicas are
 *                 at max, so KEDA cannot help.
 */
export function queueWarnings(
  q: KnightQueue,
  maxReplicas: number | undefined,
  thresholdSeconds = OLDEST_WAIT_WARN_SECONDS,
): QueueWarning[] {
  const out: QueueWarning[] = []
  if (!q.consumerFound || q.error) return out
  if (q.oldestWaitSeconds > thresholdSeconds) {
    out.push({
      kind: 'oldest-wait',
      label: `Waiting ${formatWait(q.oldestWaitSeconds)}`,
      detail: `Oldest task has waited longer than ${formatWait(thresholdSeconds)}`,
    })
  }
  if (q.pending > 0 && q.freeSlots <= 0 && maxReplicas != null && q.replicas >= maxReplicas) {
    out.push({
      kind: 'saturated',
      label: 'At max replicas',
      detail: `${q.pending} pending, no free slots and ${q.replicas}/${maxReplicas} replicas`,
    })
  }
  return out
}

/** Only allow http(s) links from the API into an href. */
export function safeExternalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : undefined
  } catch {
    return undefined
  }
}

/** Point on a sparkline in SVG coordinates; y is null for gaps. */
export interface SparkPoint {
  x: number
  y: number | null
}

export interface SparkGeometry {
  pending: SparkPoint[]
  replicas: SparkPoint[]
  events: { x: number; event: ScaleEvent }[]
  pendingMax: number
  replicasMax: number
  t0: number
  t1: number
}

/**
 * Lay samples out on [0,width] × [0,height] (y down) for two small charts that
 * share one time axis: pending tasks and replicas. Each has its own y-scale
 * from 0 to its max; they are drawn as separate charts, never on a dual axis.
 */
export function sparkGeometry(
  samples: QueueSample[],
  events: ScaleEvent[],
  width: number,
  height: number,
): SparkGeometry {
  const times = samples.map(s => Date.parse(s.t))
  const t0 = times.length ? Math.min(...times) : 0
  const t1 = times.length ? Math.max(...times) : 0
  const span = t1 - t0
  const xOf = (t: number) => (span > 0 ? ((t - t0) / span) * width : width)

  const pendingMax = Math.max(1, ...samples.map(s => s.pending ?? 0))
  const replicasMax = Math.max(
    1,
    ...samples.map(s => Math.max(s.replicas, s.maxReplicas ?? 0)),
  )
  const yOf = (v: number, max: number) => height - (v / max) * height

  return {
    pending: samples.map((s, i) => ({
      x: xOf(times[i]),
      y: s.pending == null ? null : yOf(s.pending, pendingMax),
    })),
    replicas: samples.map((s, i) => ({ x: xOf(times[i]), y: yOf(s.replicas, replicasMax) })),
    events: events
      .map(e => ({ t: Date.parse(e.t), event: e }))
      .filter(e => Number.isFinite(e.t) && e.t >= t0 && e.t <= t1)
      .map(e => ({ x: xOf(e.t), event: e.event })),
    pendingMax,
    replicasMax,
    t0,
    t1,
  }
}

/** SVG path for a line with gaps where y is null. step=true draws a step line. */
export function sparkPath(points: SparkPoint[], step = false): string {
  let d = ''
  let prev: SparkPoint | null = null
  for (const p of points) {
    if (p.y == null) {
      prev = null
      continue
    }
    if (!prev) {
      d += `M${p.x.toFixed(1)},${p.y.toFixed(1)}`
    } else if (step) {
      d += `H${p.x.toFixed(1)}V${p.y.toFixed(1)}`
    } else {
      d += `L${p.x.toFixed(1)},${p.y.toFixed(1)}`
    }
    prev = p
  }
  return d
}
