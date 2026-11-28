import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTaskPoller } from './useTaskPoller'
import { ApiError } from '../lib/api'

vi.mock('../lib/api', async (orig) => {
  const actual = await orig<typeof import('../lib/api')>()
  return { ...actual, apiGet: vi.fn() }
})
import { apiGet } from '../lib/api'
const get = vi.mocked(apiGet)

interface Item { id: string; done?: boolean }

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

// The first poll wait is jittered +-10 % (#628); pin it so one interval is exactly one tick.
let random: ReturnType<typeof vi.spyOn>
beforeEach(() => { vi.useFakeTimers(); random = vi.spyOn(Math, 'random').mockReturnValue(0.5); setHidden(false); get.mockReset() })
afterEach(() => { vi.useRealTimers(); random.mockRestore(); setHidden(false) })

function setup(extra: { maxFailures?: number; giveUpOn404?: boolean } = {}, items: Item[] = [{ id: 'a' }, { id: 'done', done: true }]) {
  const onUpdate = vi.fn()
  const onGiveUp = vi.fn()
  renderHook(() => useTaskPoller<Item, { v: number }>({
    items, idOf: (i) => i.id, isDone: (i) => !!i.done,
    fetchUrl: (i) => `/t/${i.id}`, onUpdate, onGiveUp, ...extra,
  }))
  return { onUpdate, onGiveUp }
}

describe('useTaskPoller', () => {
  it('polls only not-done items and reports successes', async () => {
    get.mockResolvedValue({ v: 1 })
    const { onUpdate } = setup()
    await vi.advanceTimersByTimeAsync(2000)
    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0][0]).toBe('/t/a')
    expect(onUpdate).toHaveBeenCalledWith('a', { v: 1 })
  })

  it('gives up after five consecutive failures, resetting on success', async () => {
    get.mockRejectedValue(new Error('boom'))
    const { onGiveUp } = setup()
    await vi.advanceTimersByTimeAsync(2000 * 4)
    expect(onGiveUp).not.toHaveBeenCalled()
    get.mockResolvedValueOnce({ v: 1 })
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(2000 * 4)
    expect(onGiveUp).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp.mock.calls[0][0]).toBe('a')
  })

  it('gives up immediately on 404 with giveUpOn404', async () => {
    get.mockRejectedValue(new ApiError(404, 'nope'))
    const { onGiveUp } = setup({ giveUpOn404: true, maxFailures: Infinity })
    await vi.advanceTimersByTimeAsync(2000)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  it('keeps retrying other errors when maxFailures is Infinity', async () => {
    get.mockRejectedValue(new Error('boom'))
    const { onGiveUp } = setup({ giveUpOn404: true, maxFailures: Infinity })
    await vi.advanceTimersByTimeAsync(2000 * 20)
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it('does not poll while the tab is hidden', async () => {
    get.mockResolvedValue({ v: 1 })
    setHidden(true)
    setup()
    await vi.advanceTimersByTimeAsync(10000)
    expect(get).not.toHaveBeenCalled()
  })
})
