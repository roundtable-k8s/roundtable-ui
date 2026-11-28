import { describe, it, expect } from 'vitest'
import {
  applyRunningDelta,
  countByStatus,
  filterRunning,
  formatRunningAge,
  parseRunningDelta,
  parseRunningResponse,
  type RunningTask,
} from './running'

const task = (over: Partial<RunningTask> = {}): RunningTask => ({
  taskId: 't1',
  knight: 'galahad',
  status: 'running',
  startedAt: '2026-11-24T10:00:00Z',
  ...over,
})

describe('parseRunningResponse', () => {
  it('accepts {tasks: [...]} and a bare array, dropping invalid entries', () => {
    const body = { tasks: [task(), { taskId: 'x' }, null, task({ taskId: 't2', status: 'bogus' as never })] }
    const m = parseRunningResponse(body)
    expect([...m.keys()]).toEqual(['t1', 't2'])
    expect(m.get('t2')!.status).toBe('running')
    expect(parseRunningResponse([task()]).size).toBe(1)
    expect(parseRunningResponse('nope').size).toBe(0)
  })

  it('drops a malformed lastTool', () => {
    const m = parseRunningResponse([{ ...task(), lastTool: 'Bash' }])
    expect(m.get('t1')!.lastTool).toBeUndefined()
  })
})

describe('parseRunningDelta / applyRunningDelta', () => {
  it('upserts, updates and removes (start → heartbeat → finish)', () => {
    let m: ReadonlyMap<string, RunningTask> = new Map()
    m = applyRunningDelta(m, parseRunningDelta({ op: 'upsert', task: task() })!)
    expect(m.get('t1')!.status).toBe('running')
    m = applyRunningDelta(m, parseRunningDelta({ op: 'upsert', task: task({ status: 'stale', costUsd: 0.5 }) })!)
    expect(m.get('t1')).toMatchObject({ status: 'stale', costUsd: 0.5 })
    m = applyRunningDelta(m, parseRunningDelta({ op: 'remove', taskId: 't1' })!)
    expect(m.size).toBe(0)
  })

  it('replaces everything on snapshot', () => {
    const m = applyRunningDelta(new Map([['old', task({ taskId: 'old' })]]), parseRunningDelta({ op: 'snapshot', tasks: [task()] })!)
    expect([...m.keys()]).toEqual(['t1'])
  })

  it('returns the same map when removing an unknown task', () => {
    const m = new Map([['t1', task()]])
    expect(applyRunningDelta(m, { op: 'remove', taskId: 'zz' })).toBe(m)
  })

  it('rejects unknown or malformed deltas', () => {
    expect(parseRunningDelta(null)).toBeNull()
    expect(parseRunningDelta({ op: 'explode' })).toBeNull()
    expect(parseRunningDelta({ op: 'upsert', task: { knight: 'x' } })).toBeNull()
    expect(parseRunningDelta({ op: 'remove' })).toBeNull()
  })
})

describe('filterRunning / countByStatus', () => {
  const all = [
    task({ taskId: 'a', knight: 'galahad', chainName: 'c1', startedAt: '2026-11-24T10:02:00Z' }),
    task({ taskId: 'b', knight: 'lancelot', status: 'stale', startedAt: '2026-11-24T10:01:00Z' }),
    task({ taskId: 'c', knight: 'galahad', status: 'lost', chainName: 'c2', startedAt: '2026-11-24T10:00:00Z' }),
  ]

  it('filters by knight, chain and status and sorts oldest first', () => {
    expect(filterRunning(all, {}).map((t) => t.taskId)).toEqual(['c', 'b', 'a'])
    expect(filterRunning(all, { knight: 'galahad' }).map((t) => t.taskId)).toEqual(['c', 'a'])
    expect(filterRunning(all, { chain: 'c1' }).map((t) => t.taskId)).toEqual(['a'])
    expect(filterRunning(all, { status: 'stale' }).map((t) => t.taskId)).toEqual(['b'])
  })

  it('counts by status', () => {
    expect(countByStatus(all)).toEqual({ running: 1, stale: 1, lost: 1 })
  })
})

describe('formatRunningAge', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  it('formats seconds, minutes and hours', () => {
    expect(formatRunningAge('2026-11-24T11:59:48Z', now)).toBe('12s')
    expect(formatRunningAge('2026-11-24T11:55:57Z', now)).toBe('4m 3s')
    expect(formatRunningAge('2026-11-24T09:55:00Z', now)).toBe('2h 5m')
    expect(formatRunningAge(undefined, now)).toBe('—')
    expect(formatRunningAge('garbage', now)).toBe('—')
    expect(formatRunningAge('2026-11-24T12:00:05Z', now)).toBe('0s')
  })
})

describe('applyRunningDelta table', () => {
  const base = { taskId: 'a', knight: 'galahad', status: 'running' as const, startedAt: '2026-11-24T10:00:00Z' }
  it('keeps the known table when an upsert has none', () => {
    const prev = new Map([['a', { ...base, table: 'alpha' }]])
    const next = applyRunningDelta(prev, { op: 'upsert', task: { ...base, table: '' } })
    expect(next.get('a')!.table).toBe('alpha')
  })
  it('takes the table an upsert carries', () => {
    const prev = new Map([['a', { ...base, table: 'alpha' }]])
    const next = applyRunningDelta(prev, { op: 'upsert', task: { ...base, table: 'beta' } })
    expect(next.get('a')!.table).toBe('beta')
  })
  it('keeps the known table when an upsert is tagged "none"', () => {
    const prev = new Map([['a', { ...base, table: 'alpha' }]])
    const next = applyRunningDelta(prev, { op: 'upsert', task: { ...base, table: 'none' } })
    expect(next.get('a')!.table).toBe('alpha')
  })
  it('stores "none" for an unknown task', () => {
    const next = applyRunningDelta(new Map(), { op: 'upsert', task: { ...base, table: 'none' } })
    expect(next.get('a')!.table).toBe('none')
  })
  it('replaces a "none" table with a real one', () => {
    const prev = new Map([['a', { ...base, table: 'none' }]])
    const next = applyRunningDelta(prev, { op: 'upsert', task: { ...base, table: 'beta' } })
    expect(next.get('a')!.table).toBe('beta')
  })
})
