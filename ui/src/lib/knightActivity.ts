import { parseEvent } from './events'
import type { NatsEvent } from '../hooks/useWebSocket'

/** Per-knight activity shown on the Fleet cards. */
export interface KnightActivity {
  /** Results in the activity window (30 min). */
  recent: number
  /** Timestamp (as received) of the newest result in the window. */
  lastActive: string | null
  /** A task in the last 60 s has no result newer than it. */
  busy: boolean
  /** Result counts in five 6-minute buckets, oldest first, normalised to 0-1. */
  sparkline: number[]
}

export const ACTIVITY_WINDOW_MS = 30 * 60 * 1000
const SPARKLINE_BUCKETS = 5
const BUSY_WINDOW_MS = 60 * 1000

interface Accumulator {
  recent: number
  lastActive: string | null
  lastActiveMs: number
  counts: number[]
  /** Newest result timestamp (ms) in the window. */
  newestResultMs: number
  /** Newest task timestamp (ms) within the busy window. */
  busyTaskMs: number
}

/**
 * Per-knight activity over the last ACTIVITY_WINDOW_MS, computed in one pass.
 *
 * Each event is parsed once. Events with an unparseable timestamp, outside the
 * window, or without a resolvable knight are ignored. A knight is busy when it
 * has a task in the last 60 s and no result newer than that task.
 */
export function computeKnightActivity(
  events: readonly NatsEvent[],
  now: number,
): Record<string, KnightActivity> {
  const intervalMs = ACTIVITY_WINDOW_MS / SPARKLINE_BUCKETS
  const acc = new Map<string, Accumulator>()

  for (const event of events) {
    const ts = new Date(event.timestamp).getTime()
    if (Number.isNaN(ts) || now - ts > ACTIVITY_WINDOW_MS) continue

    const name = parseEvent(event).knight
    if (!name) continue

    let a = acc.get(name)
    if (!a) {
      a = {
        recent: 0,
        lastActive: null,
        lastActiveMs: -Infinity,
        counts: new Array<number>(SPARKLINE_BUCKETS).fill(0),
        newestResultMs: -Infinity,
        busyTaskMs: -Infinity,
      }
      acc.set(name, a)
    }

    if (event.type === 'result') {
      a.recent++
      if (ts > a.lastActiveMs) {
        a.lastActiveMs = ts
        a.lastActive = event.timestamp
      }
      if (ts > a.newestResultMs) a.newestResultMs = ts
      // Future-dated results land in the newest bucket.
      const age = Math.max(0, now - ts)
      const bucket = Math.min(SPARKLINE_BUCKETS - 1, Math.floor(age / intervalMs))
      a.counts[SPARKLINE_BUCKETS - 1 - bucket]++
    } else if (event.type === 'task' && now - ts <= BUSY_WINDOW_MS) {
      if (ts > a.busyTaskMs) a.busyTaskMs = ts
    }
  }

  const activity: Record<string, KnightActivity> = {}
  for (const [name, a] of acc) {
    const max = Math.max(1, ...a.counts)
    activity[name] = {
      recent: a.recent,
      lastActive: a.lastActive,
      busy: a.busyTaskMs > -Infinity && a.newestResultMs <= a.busyTaskMs,
      sparkline: a.counts.map((v) => v / max),
    }
  }
  return activity
}
