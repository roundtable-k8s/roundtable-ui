import type { Chain, ChainStep } from './types'

/** One loop round drawn as a segment of the loop step's row. */
export interface TimelineRound {
  iteration: number
  startPct: number
  widthPct: number
  durationMs: number
}

/** One step on the run's shared time axis. Without startPct the step has no bar. */
export interface TimelineRow {
  name: string
  phase: string
  startPct?: number
  widthPct?: number
  durationMs?: number
  costUSD?: string
  rounds?: TimelineRound[]
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

interface Interval { start: number; end: number }

/** A step's interval; a started step without completionTime runs until `now`. */
function interval(start: string | null | undefined, end: string | null | undefined, now: number): Interval | null {
  const s = ms(start)
  if (s === null) return null
  const e = ms(end) ?? now
  return { start: s, end: Math.max(s, e) }
}

function stepInterval(step: ChainStep, now: number): Interval | null {
  const own = interval(step.startTime, step.completionTime, now)
  if (own) return own
  // A loop step without its own times spans its rounds.
  const spans = roundIntervals(step, now).map(r => r.iv)
  if (spans.length === 0) return null
  return { start: Math.min(...spans.map(i => i.start)), end: Math.max(...spans.map(i => i.end)) }
}

function roundIntervals(step: ChainStep, now: number): { iteration: number; iv: Interval }[] {
  const out: { iteration: number; iv: Interval }[] = []
  for (const r of step.loop?.rounds ?? []) {
    const ivs = (r.steps ?? [])
      .map(s => interval(s.startTime, s.completionTime, now))
      .filter((i): i is Interval => i !== null)
    if (ivs.length === 0) continue
    out.push({
      iteration: r.iteration,
      iv: { start: Math.min(...ivs.map(i => i.start)), end: Math.max(...ivs.map(i => i.end)) },
    })
  }
  return out
}

/**
 * Rows for the chain run timeline, positioned against the run's own span
 * (chain start to completion, or `now` while running). Steps without a
 * startTime (pending, skipped) get a row but no bar.
 */
export function timelineRows(chain: Chain, now: number): TimelineRow[] {
  const steps = chain.steps ?? []
  const ivs = steps.map(s => stepInterval(s, now))
  const starts = ivs.filter((i): i is Interval => i !== null).map(i => i.start)
  const ends = ivs.filter((i): i is Interval => i !== null).map(i => i.end)
  const spanStart = ms(chain.startTime) ?? (starts.length ? Math.min(...starts) : now)
  const chainEnd = ms(chain.completionTime)
  const spanEnd = Math.max(chainEnd ?? now, ...ends)
  const span = Math.max(0, spanEnd - spanStart)

  const pct = (t: number) => (span === 0 ? 0 : Math.min(100, Math.max(0, ((t - spanStart) / span) * 100)))
  const width = (iv: Interval) => (span === 0 ? 100 : Math.min(100 - pct(iv.start), pct(iv.end) - pct(iv.start)))

  return steps.map((step, i) => {
    const row: TimelineRow = { name: step.name, phase: step.phase, costUSD: step.costUSD }
    const iv = ivs[i]
    if (!iv) return row
    row.startPct = pct(iv.start)
    row.widthPct = width(iv)
    row.durationMs = iv.end - iv.start
    const rounds = roundIntervals(step, now)
    if (rounds.length > 0) {
      row.rounds = rounds.map(r => ({
        iteration: r.iteration,
        startPct: pct(r.iv.start),
        widthPct: width(r.iv),
        durationMs: r.iv.end - r.iv.start,
      }))
    }
    return row
  })
}
