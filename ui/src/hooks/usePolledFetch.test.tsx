import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePolledFetch } from './usePolledFetch'
import { apiGet } from '../lib/api'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))
const mockGet = vi.mocked(apiGet)

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

beforeEach(() => { vi.useFakeTimers(); mockGet.mockReset(); setHidden(false) })
afterEach(() => { vi.useRealTimers() })

describe('usePolledFetch', () => {
  it('loads on mount, then polls on the interval', async () => {
    mockGet.mockResolvedValue(['a'])
    const { result } = renderHook(() => usePolledFetch<string[]>('/api/x', 1000, []))
    expect(result.current.loading).toBe(true)
    expect(result.current.data).toEqual([])
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.loading).toBe(false)
    expect(result.current.data).toEqual(['a'])
    expect(mockGet).toHaveBeenCalledTimes(1)

    mockGet.mockResolvedValue(['b'])
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(result.current.data).toEqual(['b'])
  })

  it('keeps the last good data when a poll fails, and recovers', async () => {
    mockGet.mockResolvedValue(['good'])
    const { result } = renderHook(() => usePolledFetch<string[]>('/api/x', 1000, []))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    mockGet.mockRejectedValue(new Error('gateway down'))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(result.current.error).toBe('gateway down')
    expect(result.current.data).toEqual(['good'])

    mockGet.mockResolvedValue(['better'])
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(result.current.error).toBeNull()
    expect(result.current.data).toEqual(['better'])
  })

  it('drops the response of the old url after the url changes', async () => {
    const old = deferred<string[]>()
    mockGet.mockImplementation((url: string) =>
      url === '/api/a' ? old.promise : Promise.resolve(['from-b']))
    const { result, rerender } = renderHook(({ url }) => usePolledFetch<string[]>(url, 60000, []), {
      initialProps: { url: '/api/a' },
    })
    rerender({ url: '/api/b' })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.data).toEqual(['from-b'])

    await act(async () => { old.resolve(['stale-a']); await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.data).toEqual(['from-b'])
  })

  it('shows no data from the old url while the new one loads', async () => {
    const next = deferred<string[]>()
    mockGet.mockImplementation((url: string) =>
      url === '/api/a' ? Promise.resolve(['from-a']) : next.promise)
    const { result, rerender } = renderHook(({ url }) => usePolledFetch<string[]>(url, 60000, []), {
      initialProps: { url: '/api/a' },
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.data).toEqual(['from-a'])

    rerender({ url: '/api/b' })
    expect(result.current.data).toEqual([])
    expect(result.current.loading).toBe(true)
  })

  it('stops polling while the tab is hidden and refreshes when visible again', async () => {
    mockGet.mockResolvedValue(['a'])
    renderHook(() => usePolledFetch<string[]>('/api/x', 1000, []))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(mockGet).toHaveBeenCalledTimes(1)

    act(() => setHidden(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockGet).toHaveBeenCalledTimes(1)

    await act(async () => { setHidden(false); await vi.advanceTimersByTimeAsync(0) })
    expect(mockGet).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(mockGet).toHaveBeenCalledTimes(3)
  })

  it('stops polling on unmount', async () => {
    mockGet.mockResolvedValue([])
    const { unmount } = renderHook(() => usePolledFetch<string[]>('/api/x', 1000, []))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(mockGet).toHaveBeenCalledTimes(1)
  })
})
