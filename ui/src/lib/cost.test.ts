import { describe, it, expect } from 'vitest'
import { costPanelCsv, costText, notionalShare, parseUSD, tokenCount, tokensText } from './cost'

describe('cost helpers', () => {
  it('formats costs and falls back to — without data', () => {
    expect(costText('0.750000')).toBe('$0.75')
    expect(costText('0.001200')).toBe('$0.0012')
    expect(costText(undefined)).toBe('—')
    expect(costText('')).toBe('—')
    expect(costText('n/a')).toBe('—')
    expect(parseUSD('0')).toBe(0)
  })

  it('formats token counts', () => {
    expect(tokenCount(950)).toBe('950')
    expect(tokenCount(1500)).toBe('1.5k')
    expect(tokenCount(10000)).toBe('10k')
    expect(tokenCount(12345)).toBe('12.3k')
    expect(tokenCount(100000)).toBe('100k')
    expect(tokenCount(2_500_000)).toBe('2.5M')
    expect(tokensText({ input: 30000, output: 4500 })).toBe('30k in / 4.5k out')
    expect(tokensText(undefined)).toBe('—')
    expect(tokensText(null)).toBe('—')
  })

  it('tells whether a total is all, partly or not notional', () => {
    expect(notionalShare('0.750000', '0.250000')).toBe('partial')
    expect(notionalShare('0.750000', '0.750000')).toBe('all')
    // Mission totals are rounded to 4 decimals, chain sums to 6.
    expect(notionalShare('0.7500', '0.750012')).toBe('all')
    expect(notionalShare('0.750000', undefined)).toBe('none')
    expect(notionalShare(undefined, '0.25')).toBe('none')
  })
})

describe('costPanelCsv', () => {
  it('writes three labelled sections with the panel figures', () => {
    const rows = costPanelCsv({
      costByKnight: [{ knight: '=cmd', cost: 1.5, tasks: 2, failures: 1 }],
      dailyCosts: [{ date: 'Jan 1', cost: 1.5 }],
      topTasks: [{ knight: 'galahad', cost: 0.0000012, taskId: 't-1', timestamp: '2026-01-01T00:00:00Z', success: false }],
    })
    expect(rows).toEqual([
      ['By knight'],
      ['Knight', 'Cost (USD)', 'Tasks', 'Failed'],
      ['=cmd', 1.5, 2, 1],
      [],
      ['By day'],
      ['Day', 'Cost (USD)'],
      ['Jan 1', 1.5],
      [],
      ['Top tasks'],
      ['Task', 'Knight', 'Cost (USD)', 'Time', 'Status'],
      ['t-1', 'galahad', 0.000001, '2026-01-01T00:00:00Z', 'failed'],
    ])
  })
})
