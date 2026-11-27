import { describe, it, expect } from 'vitest'
import { schedulesFor, taskRows } from './knightTasks'
import type { Schedule } from './schedules'

const sched = (name: string, target: Schedule['target'], over: Partial<Schedule> = {}): Schedule => ({
  name, namespace: 'ns', cron: '* * * * *', timeZone: 'UTC', target, suspended: false, managedBy: 'api', ...over,
})

describe('schedulesFor', () => {
  it('keeps only knight-kind schedules with the same name', () => {
    const list = [
      sched('a', { kind: 'knight', summary: '', knight: 'galahad' }),
      sched('b', { kind: 'knight', summary: '', knight: 'bors' }),
      sched('c', { kind: 'chain', summary: '', chain: 'x' }),
      sched('d', { kind: 'chain', summary: '', knight: 'galahad' }),
      sched('e', { kind: 'chain', summary: '', knight: 'galahad' }, { table: 't1' }),
    ]
    expect(schedulesFor('galahad', undefined, list).map((s) => s.name)).toEqual(['a'])
  })
  it('requires equal tables when both sides have one', () => {
    const k = { kind: 'knight', summary: '', knight: 'galahad' } as Schedule['target']
    const list = [sched('alpha', k, { table: 'alpha' }), sched('beta', k, { table: 'beta' }), sched('none', k)]
    expect(schedulesFor('galahad', 'alpha', list).map((s) => s.name)).toEqual(['alpha', 'none'])
    expect(schedulesFor('galahad', 'none', list).map((s) => s.name)).toEqual(['alpha', 'beta', 'none'])
    expect(schedulesFor('galahad', undefined, list)).toHaveLength(3)
  })
  it('tolerates a missing list', () => {
    expect(schedulesFor('x', undefined, undefined)).toEqual([])
  })
})

describe('taskRows', () => {
  it('accepts {tasks} or an array and drops rows without an ID', () => {
    const t = { taskId: 't1', status: 'succeeded', cost: 0.5, durationMs: 1200, createdAt: '2026-01-01T00:00:00Z', traceId: 'ab' }
    expect(taskRows({ tasks: [t, { status: 'x' }, null] })).toEqual([t])
    expect(taskRows([t])).toHaveLength(1)
  })
  it('returns [] for garbage and defaults status', () => {
    expect(taskRows(null)).toEqual([])
    expect(taskRows({ tasks: 3 })).toEqual([])
    expect(taskRows([{ taskId: 'q' }])[0].status).toBe('unknown')
  })
})
