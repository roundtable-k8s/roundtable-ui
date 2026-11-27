import { describe, it, expect } from 'vitest'
import { costByChain } from './chainCost'
import type { Chain } from './types'

const NOW = Date.parse('2026-11-27T09:00:00Z')
const H = 60 * 60 * 1000

function chain(name: string, extra: Partial<Chain> = {}): Chain {
  return {
    name,
    namespace: 'default',
    phase: 'Succeeded',
    currentStep: '',
    startTime: new Date(NOW - H).toISOString(),
    completionTime: new Date(NOW - H).toISOString(),
    steps: null,
    ...extra,
  }
}

describe('costByChain', () => {
  it('groups run copies of one template into one row with the summed cost', () => {
    const rows = costByChain([
      chain('digest-1', { runTemplate: 'digest', costUSD: '0.10' }),
      chain('digest-2', { runTemplate: 'digest', costUSD: '0.20' }),
      chain('digest-3', { runTemplate: 'digest', costUSD: '0.30' }),
    ], -Infinity)
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe('digest')
    expect(rows[0].runs).toBe(3)
    expect(rows[0].costUSD).toBeCloseTo(0.6, 10)
  })

  it('groups a standalone chain by its own name', () => {
    const rows = costByChain([chain('solo', { costUSD: '1.5' })], -Infinity)
    expect(rows[0].key).toBe('solo')
    expect(rows[0].runs).toBe(1)
  })

  it('shows null cost when no run has cost data, and skips unparsable costs', () => {
    const rows = costByChain([
      chain('a', { runTemplate: 'none' }),
      chain('b', { runTemplate: 'none', costUSD: '' }),
      chain('c', { runTemplate: 'bad', costUSD: 'n/a' }),
      chain('d', { runTemplate: 'bad', costUSD: '0.25' }),
    ], -Infinity)
    const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
    expect(byKey.none.runs).toBe(2)
    expect(byKey.none.costUSD).toBeNull()
    expect(byKey.bad.runs).toBe(2)
    expect(byKey.bad.costUSD).toBeCloseTo(0.25, 10)
  })

  it('sums the notional part separately', () => {
    const [row] = costByChain([
      chain('a', { runTemplate: 't', costUSD: '0.5', notionalCostUSD: '0.2' }),
      chain('b', { runTemplate: 't', costUSD: '0.5' }),
      chain('c', { runTemplate: 't', costUSD: '1', notionalCostUSD: '1' }),
    ], -Infinity)
    expect(row.costUSD).toBeCloseTo(2, 10)
    expect(row.notionalUSD).toBeCloseTo(1.2, 10)
  })

  it('sorts by cost, highest first, with no-cost rows last', () => {
    const rows = costByChain([
      chain('none'),
      chain('small', { costUSD: '0.1' }),
      chain('big', { costUSD: '2' }),
    ], -Infinity)
    expect(rows.map(r => r.key)).toEqual(['big', 'small', 'none'])
  })

  it('keeps only chains at or after sinceMs and reports the latest time', () => {
    const old = chain('old-1', { runTemplate: 'd', costUSD: '5', completionTime: new Date(NOW - 10 * 24 * H).toISOString() })
    const recent = chain('d-1', { runTemplate: 'd', costUSD: '1', completionTime: new Date(NOW - 2 * H).toISOString() })
    const newest = chain('d-2', { runTemplate: 'd', costUSD: '2', completionTime: new Date(NOW - H).toISOString() })
    const rows = costByChain([old, recent, newest], NOW - 7 * 24 * H)
    expect(rows).toHaveLength(1)
    expect(rows[0].runs).toBe(2)
    expect(rows[0].costUSD).toBeCloseTo(3, 10)
    expect(rows[0].latest).toBe(new Date(NOW - H).toISOString())
  })

  it('uses startTime when a chain has no completion time, and drops chains with no time', () => {
    const running = chain('r', { completionTime: null, startTime: new Date(NOW - H).toISOString(), costUSD: '0.4' })
    const untimed = chain('u', { startTime: null, completionTime: null, costUSD: '9' })
    const rows = costByChain([running, untimed], NOW - 24 * H)
    expect(rows).toHaveLength(1)
    expect(rows[0].costUSD).toBeCloseTo(0.4, 10)
    expect(costByChain([untimed], -Infinity)).toEqual([])
  })
})
