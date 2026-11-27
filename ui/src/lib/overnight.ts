/** "What happened since I last looked": a summary of chains, dead letters and schedules since a time. Pure. */
import type { Chain } from './types'
import type { Schedule } from './schedules'
import { deadLetterTime, type DeadLetter } from './deadLetters'
import { parseUSD } from './cost'

export interface OvernightInput {
  chains: Chain[]
  deadLetters: DeadLetter[]
  schedules: Schedule[]
}

export interface OvernightSummary {
  /** Runs that reached Succeeded, Failed or PartiallySucceeded at or after `since`. */
  finished: number
  succeeded: number
  /** Failed and PartiallySucceeded runs. */
  failed: number
  failedRuns: Chain[]
  /** Cost of the finished runs, notional part included. */
  costUSD: number
  /** The part of costUSD that is notional (subscription-billed knights). */
  notionalCostUSD: number
  /** costUSD without the notional part. */
  spendUSD: number
  openDeadLetters: DeadLetter[]
  firedSchedules: Schedule[]
  /** Fired schedules whose last result is not a success. */
  failedSchedules: Schedule[]
}

/** Epoch ms of a timestamp; null when absent or malformed. */
export function timeMs(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

const atOrAfter = (s: string | null | undefined, sinceMs: number) => {
  const t = timeMs(s)
  return t !== null && t >= sinceMs
}

export function summarise(input: Partial<OvernightInput>, sinceMs: number): OvernightSummary {
  const finishedRuns = (input.chains ?? []).filter(
    (c) => (c.phase === 'Succeeded' || c.phase === 'Failed' || c.phase === 'PartiallySucceeded') && atOrAfter(c.completionTime, sinceMs),
  )
  const failedRuns = finishedRuns.filter((c) => c.phase !== 'Succeeded')
  let costUSD = 0
  let notionalCostUSD = 0
  for (const c of finishedRuns) {
    const cost = parseUSD(c.costUSD)
    if (cost === null) continue
    costUSD += cost
    notionalCostUSD += Math.min(Math.max(parseUSD(c.notionalCostUSD) ?? 0, 0), cost)
  }
  const firedSchedules = (input.schedules ?? []).filter((s) => atOrAfter(s.lastRunAt, sinceMs))
  return {
    finished: finishedRuns.length,
    succeeded: finishedRuns.length - failedRuns.length,
    failed: failedRuns.length,
    failedRuns,
    costUSD,
    notionalCostUSD,
    spendUSD: costUSD - notionalCostUSD,
    openDeadLetters: (input.deadLetters ?? []).filter((d) => d.state === 'open' && atOrAfter(deadLetterTime(d), sinceMs)),
    firedSchedules,
    failedSchedules: firedSchedules.filter((s) => s.lastResult?.outcome !== 'succeeded'),
  }
}

export const SINCE_PRESETS = [
  { value: '12h', label: 'Last 12 hours', ms: 12 * 3600_000 },
  { value: '24h', label: 'Last 24 hours', ms: 24 * 3600_000 },
  { value: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
] as const

export const DEFAULT_SINCE = '12h'

/** A ?since= value (preset key or datetime-local / ISO string) as epoch ms; unknown values fall back to the default preset. */
export function resolveSince(value: string, nowMs: number): number {
  const preset = SINCE_PRESETS.find((p) => p.value === value)
  if (preset) return nowMs - preset.ms
  const t = value ? Date.parse(value) : NaN
  return Number.isFinite(t) ? t : nowMs - SINCE_PRESETS[0].ms
}
