import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVisibleInterval } from './useVisibleInterval'
import { ApiError, parseRetryAfter } from '../lib/api'

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => { vi.useFakeTimers(); vi.spyOn(Math, 'random').mockReturnValue(0.5); setHidden(false) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setHidden(false) })

describe('useVisibleInterval', () => {
  it('ticks on the interval and not on mount by default', async () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('runs on mount with immediate', () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000, true, { immediate: true }))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does nothing while hidden and runs once when visible again', async () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    setHidden(true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(fn).not.toHaveBeenCalled()
    setHidden(false)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('skips ticks while the previous call is pending', async () => {
    const fn = vi.fn(() => new Promise<void>(() => {}))
    renderHook(() => useVisibleInterval(fn, 1000))
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('aborts the signal on unmount and stops ticking', async () => {
    let sig: AbortSignal | undefined
    const fn = vi.fn((s: AbortSignal) => { sig = s })
    const { unmount } = renderHook(() => useVisibleInterval(fn, 1000))
    await vi.advanceTimersByTimeAsync(1000)
    unmount()
    expect(sig?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does not run when disabled', async () => {
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000, false))
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('useVisibleInterval back-off (#628)', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5) }) // no jitter
  afterEach(() => { vi.restoreAllMocks() })

  it('spaces retries at 2x, 4x, then the 5x cap after 503s, and a success resets', async () => {
    const results: Array<() => Promise<unknown>> = [
      () => Promise.reject(new ApiError(503, 'down')),
      () => Promise.reject(new ApiError(503, 'down')),
      () => Promise.reject(new ApiError(503, 'down')),
      () => Promise.resolve('ok'),
      () => Promise.resolve('ok'),
    ]
    const fn = vi.fn(() => results.shift()!())
    renderHook(() => useVisibleInterval(fn, 1000))
    await vi.advanceTimersByTimeAsync(1000)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1) // 2x after the first failure
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3999)
    expect(fn).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1) // 4x
    expect(fn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4999)
    expect(fn).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1) // capped at 5x
    expect(fn).toHaveBeenCalledTimes(4) // this one succeeds
    await vi.advanceTimersByTimeAsync(1000) // back to the plain interval
    expect(fn).toHaveBeenCalledTimes(5)
  })

  it('waits for Retry-After on a 429', async () => {
    const results: Array<() => Promise<unknown>> = [() => Promise.reject(new ApiError(429, 'slow down', undefined, 30_000)), () => Promise.resolve('ok')]
    const fn = vi.fn(() => results.shift()!())
    renderHook(() => useVisibleInterval(fn, 5000))
    await vi.advanceTimersByTimeAsync(5000)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('does not back off on a 404 or a resolved non-error', async () => {
    const fn = vi.fn(() => Promise.reject(new ApiError(404, 'gone')))
    renderHook(() => useVisibleInterval(fn, 1000))
    await vi.advanceTimersByTimeAsync(3000)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('backs off on an error the promise resolves with', async () => {
    const fn = vi.fn(() => Promise.resolve(new ApiError(502, 'bad gateway')))
    renderHook(() => useVisibleInterval(fn, 1000))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1999)
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('jitters the first wait by at most 10 %', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0) // -10 %
    const fn = vi.fn()
    renderHook(() => useVisibleInterval(fn, 1000))
    await vi.advanceTimersByTimeAsync(899)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
