import { describe, it, expect } from 'vitest'
import { buildCostEntries, buildCostPanelData, sumCosts, localDayKey } from './dashboardCost'
import type { NatsEvent } from '../hooks/useWebSocket'

const ev = (type: 'task' | 'result', ts: string, data: Record<string, unknown>): NatsEvent =>
  ({ type, subject: `fleet.results.${String(data.task_id ?? 'x')}`, timestamp: ts, live: false, data }) as NatsEvent

const events: NatsEvent[] = [
  ev('result', '2026-11-20T12:00:00', { knight: 'galahad', cost: 1, success: true, task_id: 'a' }),
  ev('result', '2026-11-20T13:00:00', { knight: 'galahad', cost: 2, success: false, task_id: 'b' }),
  ev('result', '2026-11-21T12:00:00', { knight: 'percival', cost: 4, success: true, task_id: 'c' }),
  ev('result', '2026-11-21T12:30:00', { knight: 'percival', cost: 0, success: true, task_id: 'free' }),
  ev('task', '2026-11-21T12:30:00', { knight: 'percival', cost: 9, task_id: 'd' }),
  ev('result', '2026-11-22T12:00:00', { cost: 0.5, task_id: 'e' }),
]

describe('buildCostEntries', () => {
  it('keeps only result events with a positive cost', () => {
    const entries = buildCostEntries(events)
    expect(entries.map(e => e.taskId)).toEqual(['a', 'b', 'c', 'e'])
    expect(entries[1].success).toBe(false)
    expect(entries[3].knight).toBe('unknown')
  })
})

describe('buildCostPanelData', () => {
  const data = buildCostPanelData(buildCostEntries(events))
  it('totals and groups by knight, most expensive first', () => {
    expect(data.totalCost).toBe(7.5)
    expect(data.costByKnight).toEqual([
      { knight: 'percival', cost: 4, tasks: 1, failures: 0 },
      { knight: 'galahad', cost: 3, tasks: 2, failures: 1 },
      { knight: 'unknown', cost: 0.5, tasks: 1, failures: 0 },
    ])
  })
  it('buckets cost per local day in ascending order', () => {
    expect(data.dailyCosts.map(d => [d.day, d.cost])).toEqual([
      ['2026-11-20', 3], ['2026-11-21', 4], ['2026-11-22', 0.5],
    ])
  })
  it('keeps only the last seven days', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      ev('result', `2026-11-${String(10 + i).padStart(2, '0')}T12:00:00`, { knight: 'k', cost: 1, task_id: `t${i}` }))
    const d = buildCostPanelData(buildCostEntries(many))
    expect(d.dailyCosts).toHaveLength(7)
    expect(d.dailyCosts[0].day).toBe('2026-11-12')
  })
  it('lists top tasks by cost, capped at ten', () => {
    expect(data.topTasks.map(t => t.taskId)).toEqual(['c', 'b', 'a', 'e'])
    const many = Array.from({ length: 12 }, (_, i) => ev('result', '2026-11-20T12:00:00', { knight: 'k', cost: i + 1, task_id: `t${i}` }))
    expect(buildCostPanelData(buildCostEntries(many)).topTasks).toHaveLength(10)
  })
  it('handles no entries', () => {
    expect(buildCostPanelData([])).toEqual({ totalCost: 0, costByKnight: [], dailyCosts: [], topTasks: [] })
  })
})

describe('sumCosts / localDayKey', () => {
  it('sums entries', () => expect(sumCosts(buildCostEntries(events))).toBe(7.5))
  it('formats a local day', () => expect(localDayKey(new Date(2026, 0, 5))).toBe('2026-01-05'))
})
