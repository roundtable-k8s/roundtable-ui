import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useHealth } from '../hooks/useHealth'
import { useOpenDeadLetters } from '../hooks/useOpenDeadLetters'
import { fetchFresh, GRACE_MS } from './polledStore'
import { apiGet } from './api'

vi.mock('./api', () => ({ apiGet: vi.fn() }))
const mockGet = vi.mocked(apiGet)
const calls = (url: string) => mockGet.mock.calls.filter((c) => c[0] === url).length
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => { vi.useFakeTimers(); mockGet.mockReset(); mockGet.mockResolvedValue(['a']) })
afterEach(() => { vi.useRealTimers() })

describe('polledStore', () => {
  it('two hooks on one url cause one request per interval and share the data', async () => {
    const a = renderHook(() => usePolledFetch<string[]>('/api/x', 1000, []))
    const b = renderHook(() => usePolledFetch<string[]>('/api/x', 1000, []))
    await tick(0)
    expect(calls('/api/x')).toBe(1)
    expect(a.result.current.data).toEqual(['a'])
    expect(b.result.current.data).toEqual(['a'])
    await tick(1000)
    expect(calls('/api/x')).toBe(2)
    await tick(1000)
    expect(calls('/api/x')).toBe(3)
  })

  it('polls at the smallest interval and relaxes when that subscriber leaves', async () => {
    renderHook(() => usePolledFetch('/api/x', 4000, []))
    const fast = renderHook(() => usePolledFetch('/api/x', 1000, []))
    await tick(0)
    await tick(2000)
    expect(calls('/api/x')).toBe(3)
    fast.unmount()
    mockGet.mockClear()
    await tick(8000)
    expect(calls('/api/x')).toBe(2)
  })

  it('stops polling when the last subscriber unsubscribes', async () => {
    const a = renderHook(() => usePolledFetch('/api/x', 1000, []))
    const b = renderHook(() => usePolledFetch('/api/x', 1000, []))
    await tick(0)
    a.unmount()
    await tick(1000)
    expect(calls('/api/x')).toBe(2)
    b.unmount()
    await tick(5000)
    expect(calls('/api/x')).toBe(2)
  })

  it('keeps different urls separate', async () => {
    mockGet.mockImplementation((u: string) => Promise.resolve([u]))
    const a = renderHook(() => usePolledFetch<string[]>('/api/a', 1000, []))
    const b = renderHook(() => usePolledFetch<string[]>('/api/b', 1000, []))
    await tick(0)
    expect(a.result.current.data).toEqual(['/api/a'])
    expect(b.result.current.data).toEqual(['/api/b'])
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it('refresh() from one subscriber updates all of them with one request', async () => {
    const a = renderHook(() => usePolledFetch<string[]>('/api/x', 60000, []))
    const b = renderHook(() => usePolledFetch<string[]>('/api/x', 60000, []))
    await tick(0)
    mockGet.mockResolvedValue(['b'])
    await act(async () => { await a.result.current.refresh() })
    expect(calls('/api/x')).toBe(2)
    expect(b.result.current.data).toEqual(['b'])
  })

  it('drops the entry 30 s after the last unsubscribe, keeps it before', async () => {
    const a = renderHook(() => usePolledFetch<string[]>('/api/x', 0, []))
    await tick(0)
    a.unmount()
    await tick(GRACE_MS - 1000)
    expect(await fetchFresh('/api/x', 60_000)).toEqual(['a'])
    expect(calls('/api/x')).toBe(1)
    await tick(GRACE_MS + 1)
    await fetchFresh('/api/x', 60_000)
    expect(calls('/api/x')).toBe(2)
  })

  it('fetchFresh reuses a fresh entry and refetches a stale one', async () => {
    await fetchFresh('/api/x', 30_000)
    await fetchFresh('/api/x', 30_000)
    expect(calls('/api/x')).toBe(1)
    vi.setSystemTime(Date.now() + 31_000)
    await fetchFresh('/api/x', 30_000)
    expect(calls('/api/x')).toBe(2)
  })

  it('Dashboard-style: health and dead letters are requested once for two consumers', async () => {
    mockGet.mockImplementation((u: string) => Promise.resolve(u.startsWith('/api/health') ? { status: 'ok' } : { deadLetters: [] }))
    renderHook(() => { useHealth(); useOpenDeadLetters('') })
    const glance = renderHook(() => ({ h: useHealth(60000), d: useOpenDeadLetters('', 60000) }))
    await tick(0)
    expect(calls('/api/health')).toBe(1)
    expect(calls('/api/dead-letters?state=open')).toBe(1)
    expect(glance.result.current.h?.status).toBe('ok')
    await tick(60000)
    expect(calls('/api/health')).toBe(2)
    expect(calls('/api/dead-letters?state=open')).toBe(2)
  })
})
