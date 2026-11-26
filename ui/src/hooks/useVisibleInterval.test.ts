import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useVisibleInterval } from './useVisibleInterval'

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => { vi.useFakeTimers(); setHidden(false) })
afterEach(() => { vi.useRealTimers(); setHidden(false) })

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
