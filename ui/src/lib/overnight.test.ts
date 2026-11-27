import { describe, it, expect } from 'vitest'
import { summarise, resolveSince, timeMs } from './overnight'
import type { Chain } from './types'
import type { DeadLetter } from './deadLetters'
import type { Schedule } from './schedules'

const SINCE = Date.parse('2026-01-01T00:00:00Z')
const chain = (name: string, phase: string, completionTime: string | null, costUSD?: string, notionalCostUSD?: string) =>
  ({ name, namespace: 'ns', phase, currentStep: '', startTime: null, completionTime, steps: null, costUSD, notionalCostUSD }) as Chain
const dl = (taskId: string, state: DeadLetter['state'], deadLetteredAt?: string, updatedAt = '2025-01-01T00:00:00Z') =>
  ({ taskId, knight: 'k', state, reason: 'r', attempt: 1, deadLetteredAt, updatedAt }) as DeadLetter
const sched = (name: string, lastRunAt?: string, outcome?: string) =>
  ({ name, namespace: 'ns', lastRunAt, lastResult: outcome ? { time: lastRunAt ?? '', outcome } : undefined }) as Schedule

describe('summarise', () => {
  it('is all zero for empty input', () => {
    const s = summarise({ chains: [], deadLetters: [], schedules: [] }, SINCE)
    expect(s).toMatchObject({ finished: 0, succeeded: 0, failed: 0, costUSD: 0, notionalCostUSD: 0, spendUSD: 0 })
    expect(s.openDeadLetters).toEqual([])
    expect(s.firedSchedules).toEqual([])
  })

  it('counts runs finished at or after since, inclusive at the boundary', () => {
    const s = summarise({
      chains: [
        chain('a', 'Succeeded', '2026-01-01T00:00:00Z', '1.5'),
        chain('b', 'Failed', '2026-01-01T00:00:01Z', '0.5'),
        chain('c', 'Succeeded', '2025-12-31T23:59:59Z', '9'),
        chain('d', 'Running', null, '3'),
        chain('e', 'PartiallySucceeded', '2026-01-02T00:00:00Z'),
      ], deadLetters: [], schedules: [],
    }, SINCE)
    expect(s.finished).toBe(3)
    expect(s.succeeded).toBe(1)
    expect(s.failed).toBe(2)
    expect(s.failedRuns.map((c) => c.name)).toEqual(['b', 'e'])
    expect(s.costUSD).toBeCloseTo(2)
  })

  it('keeps notional cost apart from spend', () => {
    const s = summarise({
      chains: [chain('a', 'Succeeded', '2026-01-02T00:00:00Z', '2', '1.5'), chain('b', 'Succeeded', '2026-01-02T00:00:00Z', '1')],
      deadLetters: [], schedules: [],
    }, SINCE)
    expect(s.costUSD).toBeCloseTo(3)
    expect(s.notionalCostUSD).toBeCloseTo(1.5)
    expect(s.spendUSD).toBeCloseTo(1.5)
  })

  it('ignores malformed timestamps and costs', () => {
    const s = summarise({
      chains: [chain('a', 'Succeeded', 'garbage', '1'), chain('b', 'Succeeded', '2026-01-02T00:00:00Z', 'NaN')],
      deadLetters: [dl('x', 'open', 'nope')],
      schedules: [sched('s', 'bad', 'succeeded')],
    }, SINCE)
    expect(s.finished).toBe(1)
    expect(s.costUSD).toBe(0)
    expect(s.openDeadLetters).toEqual([])
    expect(s.firedSchedules).toEqual([])
    expect(timeMs('')).toBeNull()
  })

  it('filters open dead letters by time and state, falling back to updatedAt', () => {
    const s = summarise({
      chains: [],
      deadLetters: [
        dl('a', 'open', '2026-01-02T00:00:00Z'),
        dl('b', 'resolved', '2026-01-02T00:00:00Z'),
        dl('c', 'open', '2025-12-31T00:00:00Z'),
        dl('d', 'open', undefined, '2026-01-03T00:00:00Z'),
      ],
      schedules: [],
    }, SINCE)
    expect(s.openDeadLetters.map((d) => d.taskId)).toEqual(['a', 'd'])
  })

  it('finds fired schedules and those that did not succeed', () => {
    const s = summarise({
      chains: [], deadLetters: [],
      schedules: [
        sched('ok', '2026-01-02T00:00:00Z', 'succeeded'),
        sched('bad', '2026-01-02T00:00:00Z', 'failed'),
        sched('none', '2026-01-02T00:00:00Z'),
        sched('old', '2025-01-02T00:00:00Z', 'failed'),
        sched('never'),
      ],
    }, SINCE)
    expect(s.firedSchedules.map((x) => x.name)).toEqual(['ok', 'bad', 'none'])
    expect(s.failedSchedules.map((x) => x.name)).toEqual(['bad', 'none'])
  })
})

describe('resolveSince', () => {
  const now = Date.parse('2026-01-10T12:00:00Z')
  it('maps presets', () => {
    expect(resolveSince('12h', now)).toBe(now - 12 * 3600_000)
    expect(resolveSince('24h', now)).toBe(now - 24 * 3600_000)
    expect(resolveSince('7d', now)).toBe(now - 7 * 86400_000)
  })
  it('parses a datetime and falls back to 12h for junk', () => {
    expect(resolveSince('2026-01-09T08:30:00Z', now)).toBe(Date.parse('2026-01-09T08:30:00Z'))
    expect(resolveSince('junk', now)).toBe(now - 12 * 3600_000)
  })
})
