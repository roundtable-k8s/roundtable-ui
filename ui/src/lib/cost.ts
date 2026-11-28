/**
 * Cost and token totals of chain runs, steps and missions (#270).
 * Subscription-billed knights report an API-equivalent cost: it is shown,
 * but marked notional so it is not read as spend.
 */
import { formatCost } from './format'
import type { TokenTotals } from './types'

export const NOTIONAL_HINT = 'Notional: subscription-billed knights report the API-equivalent cost, not money spent'

/** A status cost string as a number; null when absent or malformed. */
export function parseUSD(s: string | null | undefined): number | null {
  if (s === undefined || s === null || s === '') return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

/** "$0.75", or "—" without cost data. */
export function costText(s: string | null | undefined): string {
  const v = parseUSD(s)
  return v === null ? '—' : formatCost(v)
}

/** 950 → "950", 12345 → "12.3k", 2_500_000 → "2.5M". */
export function tokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.?0+$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** "10k in / 1.5k out", or "—" without token data. */
export function tokensText(t: Partial<TokenTotals> | null | undefined): string {
  if (!t) return '—'
  return `${tokenCount(t.input || 0)} in / ${tokenCount(t.output || 0)} out`
}

export type NotionalShare = 'none' | 'partial' | 'all'

/** How much of a total is notional. */
export function notionalShare(costUSD: string | null | undefined, notionalUSD: string | null | undefined): NotionalShare {
  const total = parseUSD(costUSD)
  const notional = parseUSD(notionalUSD)
  if (total === null || notional === null || notional <= 0) return 'none'
  // Status costs are rounded to 6 (chains) or 4 (missions) decimals.
  return notional >= total - 1e-4 ? 'all' : 'partial'
}

/** The cost panel's data, as Dashboard computes it for the selected range. */
export interface CostPanelCsvInput {
  costByKnight: { knight: string; cost: number; tasks: number; failures: number }[]
  dailyCosts: { day: string; date: string; cost: number }[]
  topTasks: { knight: string; cost: number; taskId: string; timestamp: string; success: boolean }[]
}

/** Costs as plain decimals with up to 6 places (the precision of status costs). */
const csvMoney = (n: number): number => Number(n.toFixed(6))

/**
 * Rows for the cost panel CSV: three labelled sections (by knight, by day,
 * top tasks) separated by blank rows. The figures are the panel's own data.
 */
export function costPanelCsv(data: CostPanelCsvInput): (string | number)[][] {
  const rows: (string | number)[][] = [
    ['By knight'],
    ['Knight', 'Cost (USD)', 'Tasks', 'Failed'],
    ...data.costByKnight.map(k => [k.knight, csvMoney(k.cost), k.tasks, k.failures]),
    [],
    ['By day'],
    ['Day', 'Cost (USD)'],
    ...data.dailyCosts.map(d => [d.day, csvMoney(d.cost)]),
    [],
    ['Top tasks'],
    ['Task', 'Knight', 'Cost (USD)', 'Time', 'Status'],
    ...data.topTasks.map(t => [t.taskId, t.knight, csvMoney(t.cost), t.timestamp, t.success ? 'ok' : 'failed']),
  ]
  return rows
}

/**
 * What span the recent-events buffer covers, for labelling figures computed
 * from it. The buffer holds the last few hundred events, so it is described by
 * its count and its oldest event rather than as a calendar period.
 */
export function bufferCoverage(events: { timestamp: string }[], now: number = Date.now()): string {
  let oldest = Infinity
  for (const e of events) {
    const t = new Date(e.timestamp).getTime()
    if (!Number.isNaN(t) && t < oldest) oldest = t
  }
  if (oldest === Infinity) return 'no recent events'
  const d = new Date(oldest)
  const sameDay = d.toDateString() === new Date(now).toDateString()
  const since = sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
  return `last ${events.length} events, since ${since}`
}
