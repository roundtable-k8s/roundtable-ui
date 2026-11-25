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
export function tokensText(t: TokenTotals | null | undefined): string {
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
