import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { usePolledFetch } from './usePolledFetch'

const apiGet = vi.fn()
vi.mock('../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }))

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => { vi.useFakeTimers(); apiGet.mockReset(); setHidden(false) })
afterEach(() => { vi.useRealTimers(); setHidden(false) })

describe('usePolledFetch', () => {
  it('fetches on mount and every interval', async () => {
    apiGet.mockResolvedValue({ a: 1 })
    const { result } = renderHook(() => usePolledFetch('/x', 1000, {}))
    await vi.advanceTimersByTimeAsync(2000)
    expect(apiGet).toHaveBeenCalledTimes(3)
    expect(result.current.data).toEqual({ a: 1 })
    expect(result.current.loading).toBe(false)
  })

  it('does not stack requests when one never resolves', async () => {
    apiGet.mockReturnValue(new Promise(() => {}))
    renderHook(() => usePolledFetch('/x', 1000, {}))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('aborts the pending request on url change and unmount', async () => {
    apiGet.mockReturnValue(new Promise(() => {}))
    const { rerender, unmount } = renderHook(({ u }) => usePolledFetch(u, 1000, {}), { initialProps: { u: '/a' } })
    const first = apiGet.mock.calls[0][1].signal as AbortSignal
    rerender({ u: '/b' })
    expect(first.aborted).toBe(true)
    expect(apiGet).toHaveBeenCalledTimes(2)
    const second = apiGet.mock.calls[1][1].signal as AbortSignal
    unmount()
    expect(second.aborted).toBe(true)
  })

  it('pauses on a hidden tab and refetches once when visible', async () => {
    apiGet.mockResolvedValue({})
    renderHook(() => usePolledFetch('/x', 1000, {}))
    await vi.advanceTimersByTimeAsync(0)
    setHidden(true)
    apiGet.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(apiGet).not.toHaveBeenCalled()
    setHidden(false)
    expect(apiGet).toHaveBeenCalledTimes(1)
  })
})
