import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTitleBadge, badgedTitle } from './useTitleBadge'
import type { NatsEvent } from './useWebSocket'

let seq = 0
function makeResult(live: boolean, success = true): NatsEvent {
  seq++
  return {
    type: 'result',
    subject: `fleet-a.results.task-${seq}`,
    data: { task_id: `task-${seq}`, knight: 'Galahad', success, cost: 0.01 },
    timestamp: `2026-06-10T12:00:${String(seq % 60).padStart(2, '0')}.${seq}Z`,
    live,
  }
}

let hidden = false
function setHidden(h: boolean) {
  hidden = h
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
})
afterEach(() => {
  delete (document as unknown as Record<string, unknown>).hidden
})

describe('useTitleBadge', () => {
  it('counts live results that arrive while the tab is hidden', () => {
    const { result, rerender } = renderHook(
      ({ events }: { events: NatsEvent[] }) => useTitleBadge(events),
      { initialProps: { events: [] as NatsEvent[] } },
    )
    setHidden(true)
    rerender({ events: [makeResult(true), makeResult(true, false)] })
    expect(result.current).toEqual({ count: 2, failed: 1 })
  })

  it('does not count results that arrive while the tab is visible', () => {
    const { result, rerender } = renderHook(
      ({ events }: { events: NatsEvent[] }) => useTitleBadge(events),
      { initialProps: { events: [] as NatsEvent[] } },
    )
    rerender({ events: [makeResult(true)] })
    expect(result.current).toEqual({ count: 0, failed: 0 })
  })

  it('resets when the tab becomes visible again', () => {
    const { result, rerender } = renderHook(
      ({ events }: { events: NatsEvent[] }) => useTitleBadge(events),
      { initialProps: { events: [] as NatsEvent[] } },
    )
    setHidden(true)
    rerender({ events: [makeResult(true)] })
    expect(result.current.count).toBe(1)
    act(() => setHidden(false))
    expect(result.current).toEqual({ count: 0, failed: 0 })
  })

  it('never counts seeded history (no live flag)', () => {
    const { result, rerender } = renderHook(
      ({ events }: { events: NatsEvent[] }) => useTitleBadge(events),
      { initialProps: { events: [] as NatsEvent[] } },
    )
    setHidden(true)
    const history = Array.from({ length: 5 }, () => makeResult(false))
    history.forEach((h) => delete h.live)
    rerender({ events: history })
    expect(result.current.count).toBe(0)
  })

  it('counts each event once, even when the same array is re-rendered', () => {
    const { result, rerender } = renderHook(
      ({ events }: { events: NatsEvent[] }) => useTitleBadge(events),
      { initialProps: { events: [] as NatsEvent[] } },
    )
    setHidden(true)
    const live = makeResult(true)
    rerender({ events: [live] })
    rerender({ events: [live] })
    expect(result.current.count).toBe(1)
  })

  it('does not count an event that arrived while visible when the tab hides later', () => {
    const { result, rerender } = renderHook(
      ({ events }: { events: NatsEvent[] }) => useTitleBadge(events),
      { initialProps: { events: [] as NatsEvent[] } },
    )
    const early = makeResult(true)
    rerender({ events: [early] })
    setHidden(true)
    rerender({ events: [early] })
    expect(result.current.count).toBe(0)
  })

  it('ignores non-result events', () => {
    const { result, rerender } = renderHook(
      ({ events }: { events: NatsEvent[] }) => useTitleBadge(events),
      { initialProps: { events: [] as NatsEvent[] } },
    )
    setHidden(true)
    rerender({ events: [{ ...makeResult(true), type: 'task' }] })
    expect(result.current.count).toBe(0)
  })
})

describe('badgedTitle', () => {
  it('returns the base title when nothing is pending', () => {
    expect(badgedTitle({ count: 0, failed: 0 }, 'Fleet - Round Table')).toBe('Fleet - Round Table')
  })
  it('prefixes the count, and the failures when there are any', () => {
    expect(badgedTitle({ count: 3, failed: 0 }, 'Fleet - Round Table')).toBe('(3) Fleet - Round Table')
    expect(badgedTitle({ count: 2, failed: 1 }, 'Command Center - Round Table'))
      .toBe('(2, 1 failed) Command Center - Round Table')
  })
})
