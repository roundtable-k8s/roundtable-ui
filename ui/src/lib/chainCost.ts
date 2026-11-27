/**
 * Cost by chain for the cost page: run copies of one template are grouped
 * under the template and their costs summed (#515).
 */
import { parseUSD } from './cost'
import type { Chain } from './types'

export interface ChainCostRow {
  /** Template name (runTemplate), or the chain's own name for a standalone chain. */
  key: string
  runs: number
  /** Sum of the runs' costs; null when no run has cost data. */
  costUSD: number | null
  /** Part of costUSD spent by subscription-billed knights (notional). */
  notionalUSD: number
  /** Latest completion (or start) time among the runs, ISO; null when unknown. */
  latest: string | null
}

function timeOf(c: Chain): number | null {
  const t = Date.parse(c.completionTime || c.startTime || '')
  return Number.isFinite(t) ? t : null
}

/**
 * Chains that ran at or after sinceMs, grouped by template, most expensive
 * first. Chains with no cost data count as runs but add no cost; chains with
 * no timestamp are left out of any time range.
 */
export function costByChain(chains: Chain[], sinceMs: number): ChainCostRow[] {
  const groups = new Map<string, ChainCostRow & { latestMs: number | null }>()
  for (const c of chains) {
    const t = timeOf(c)
    if (t === null || t < sinceMs) continue
    const key = c.runTemplate || c.name
    let g = groups.get(key)
    if (!g) {
      g = { key, runs: 0, costUSD: null, notionalUSD: 0, latest: null, latestMs: null }
      groups.set(key, g)
    }
    g.runs += 1
    const cost = parseUSD(c.costUSD)
    if (cost !== null) g.costUSD = (g.costUSD ?? 0) + cost
    const notional = parseUSD(c.notionalCostUSD)
    if (notional !== null) g.notionalUSD += notional
    if (g.latestMs === null || t > g.latestMs) {
      g.latestMs = t
      g.latest = new Date(t).toISOString()
    }
  }
  return [...groups.values()]
    .map(({ latestMs: _latestMs, ...row }) => row)
    .sort((a, b) => (b.costUSD ?? -1) - (a.costUSD ?? -1) || a.key.localeCompare(b.key))
}
