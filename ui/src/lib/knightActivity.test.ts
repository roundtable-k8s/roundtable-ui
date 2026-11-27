import { describe, it, expect, vi } from 'vitest'
import type { NatsEvent } from '../hooks/useWebSocket'
import { computeKnightActivity, ACTIVITY_WINDOW_MS } from './knightActivity'
import * as events from './events'

// Count parseEvent calls to pin the one-parse-per-event contract.
vi.mock('./events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./events')>()
  return { ...actual, parseEvent: vi.fn(actual.parseEvent) }
})

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const iso = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString()

/** A result event from knight `knight` at `msBeforeNow` before NOW. */
const result = (knight: string, msBeforeNow: number): NatsEvent => ({
  type: 'result',
  subject: `fleet.results.${knight}-${msBeforeNow}`,
  data: { task_id: `${knight}-${msBeforeNow}`, knight: knight[0].toUpperCase() + knight.slice(1), success: true },
  timestamp: iso(msBeforeNow),
})

/** A task event for knight `knight` (domain = knight name) at `msBeforeNow`. */
const task = (knight: string, msBeforeNow: number): NatsEvent => ({
  type: 'task',
  subject: `fleet.tasks.${knight}.${knight}-${msBeforeNow}`,
  data: { task: 'scan' },
  timestamp: iso(msBeforeNow),
})

const BUCKET = ACTIVITY_WINDOW_MS / 5

describe('computeKnightActivity', () => {
  it('returns an empty map for no events', () => {
    expect(computeKnightActivity([], NOW)).toEqual({})
  })

  it('counts results in the window and tracks the newest one as lastActive', () => {
    const out = computeKnightActivity(
      [result('galahad', 5 * 60_000), result('galahad', 90_000), result('galahad', 10 * 60_000)],
      NOW,
    )
    expect(out.galahad.recent).toBe(3)
    expect(out.galahad.lastActive).toBe(iso(90_000))
    expect(out.galahad.busy).toBe(false)
  })

  it('buckets results into a normalised five-bucket sparkline, oldest first', () => {
    const out = computeKnightActivity(
      [
        result('kay', 1_000), // newest bucket
        result('kay', 2_000), // newest bucket
        result('kay', BUCKET * 2 + 1_000), // middle bucket
        result('kay', BUCKET * 4 + 1_000), // oldest bucket
      ],
      NOW,
    )
    // counts oldest→newest: [1, 0, 1, 0, 2] / max 2
    expect(out.kay.sparkline).toEqual([0.5, 0, 0.5, 0, 1])
  })

  it('places results at the window edges in the first and last buckets', () => {
    const out = computeKnightActivity(
      [result('kay', ACTIVITY_WINDOW_MS), result('kay', BUCKET * 4 + 1)],
      NOW,
    )
    expect(out.kay.recent).toBe(2)
    expect(out.kay.sparkline).toEqual([1, 0, 0, 0, 0])
  })

  it('normalises an all-zero sparkline without dividing by zero', () => {
    const out = computeKnightActivity([task('kay', 1_000)], NOW)
    expect(out.kay.sparkline).toEqual([0, 0, 0, 0, 0])
  })

  it('ignores events outside the 30 min window', () => {
    const out = computeKnightActivity(
      [result('kay', ACTIVITY_WINDOW_MS + 1), task('kay', ACTIVITY_WINDOW_MS + 1)],
      NOW,
    )
    expect(out).toEqual({})
  })

  it('ignores events with a malformed timestamp', () => {
    const bad = { ...result('kay', 1_000), timestamp: 'not-a-date' }
    const out = computeKnightActivity([bad, result('kay', 2_000)], NOW)
    expect(out.kay.recent).toBe(1)
    expect(out.kay.lastActive).toBe(iso(2_000))
  })

  it('ignores events whose knight cannot be resolved', () => {
    const unknown: NatsEvent = {
      type: 'result',
      subject: 'fleet.results.x',
      data: { knight: '' },
      timestamp: iso(1_000),
    }
    expect(computeKnightActivity([unknown], NOW)).toEqual({})
  })

  it('is busy when a task in the last 60 s has no later result', () => {
    const out = computeKnightActivity([task('galahad', 30_000)], NOW)
    expect(out.galahad.busy).toBe(true)
  })

  it('is not busy when a result arrives after the task', () => {
    const out = computeKnightActivity([task('galahad', 30_000), result('galahad', 10_000)], NOW)
    expect(out.galahad.busy).toBe(false)
  })

  it('is not busy when the only task is older than 60 s', () => {
    const out = computeKnightActivity([task('galahad', 90_000), result('galahad', 120_000)], NOW)
    expect(out.galahad.busy).toBe(false)
  })

  it('is busy when a new task follows an earlier answered one', () => {
    const out = computeKnightActivity(
      [task('galahad', 50_000), result('galahad', 40_000), task('galahad', 5_000)],
      NOW,
    )
    expect(out.galahad.busy).toBe(true)
  })

  it('keeps knights independent', () => {
    const out = computeKnightActivity(
      [task('galahad', 5_000), task('kay', 5_000), result('kay', 1_000)],
      NOW,
    )
    expect(out.galahad.busy).toBe(true)
    expect(out.kay.busy).toBe(false)
    expect(out.kay.recent).toBe(1)
    expect(out.galahad.recent).toBe(0)
  })

  it('parses each event at most once, even for thousands of events', () => {
    vi.mocked(events.parseEvent).mockClear()
    const many: NatsEvent[] = []
    for (let i = 0; i < 5000; i++) {
      const knight = i % 2 ? 'galahad' : 'kay'
      many.push(i % 3 ? result(knight, (i % 1000) * 1_000 + 1_000) : task(knight, (i % 500) * 1_000 + 1_000))
    }
    const out = computeKnightActivity(many, NOW)
    expect(vi.mocked(events.parseEvent).mock.calls.length).toBeLessThanOrEqual(many.length)
    expect(Object.keys(out).sort()).toEqual(['galahad', 'kay'])
  })
})
