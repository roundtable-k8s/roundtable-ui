import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKnightSession } from './useKnightSession'
import { apiGet, ApiError } from '../lib/api'

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, apiGet: vi.fn() }
})
const mockGet = vi.mocked(apiGet)

afterEach(() => { vi.clearAllMocks() })

const statsBody = { knight: 'galahad', session: null, runtime: { uptime: 1, activeTasks: 0, model: 'm' } }

describe('useKnightSession.fetchStats', () => {
  it('goes through apiGet with the session timeout and a signal', async () => {
    mockGet.mockResolvedValue(statsBody)
    const { result } = renderHook(() => useKnightSession())
    await act(() => result.current.fetchStats('galahad'))
    expect(mockGet).toHaveBeenCalledWith('/api/fleet/galahad/session?type=stats', { timeoutMs: 8000, signal: expect.any(AbortSignal) })
    expect(result.current.stats?.supported).toBe(true)
    expect(result.current.error).toBeNull()
  })

  it('treats an offline knight ({}) as supported with no data', async () => {
    mockGet.mockResolvedValue({})
    const { result } = renderHook(() => useKnightSession())
    await act(() => result.current.fetchStats('galahad'))
    expect(result.current.stats?.supported).toBe(true)
    expect(result.current.stats?.session).toBeUndefined()
    expect(result.current.error).toBeNull()
  })

  it('marks the knight unsupported on a 404', async () => {
    mockGet.mockRejectedValue(new ApiError(404, 'not found'))
    const { result } = renderHook(() => useKnightSession())
    await act(() => result.current.fetchStats('galahad'))
    expect(result.current.stats?.supported).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it.each([[503, /unavailable/], [502, /unavailable/], [429, /unavailable/], [504, /in time/], [0, /in time/], [500, /Failed/]])(
    'shows an error, not "unsupported", on status %i',
    async (status, msg) => {
      mockGet.mockRejectedValue(new ApiError(status, 'x'))
      const { result } = renderHook(() => useKnightSession())
      await act(() => result.current.fetchStats('galahad'))
      expect(result.current.stats?.supported).not.toBe(false)
      expect(result.current.error).toMatch(msg)
      expect(result.current.loading).toBe(false)
    },
  )

  it('aborts the request on knight change (reset) and ignores the aborted answer', async () => {
    let signal!: AbortSignal
    mockGet.mockImplementation((_u, init) => new Promise((_res, rej) => {
      signal = init!.signal!
      signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const { result } = renderHook(() => useKnightSession())
    let p!: Promise<void>
    act(() => { p = result.current.fetchStats('galahad') })
    act(() => result.current.reset())
    expect(signal.aborted).toBe(true)
    await act(() => p)
    expect(result.current.error).toBeNull()
    expect(result.current.stats).toBeNull()
  })

  it('aborts on unmount', async () => {
    let signal!: AbortSignal
    mockGet.mockImplementation((_u, init) => { signal = init!.signal!; return new Promise(() => {}) })
    const { result, unmount } = renderHook(() => useKnightSession())
    act(() => { void result.current.fetchStats('galahad') })
    unmount()
    expect(signal.aborted).toBe(true)
  })
})

describe('useKnightSession.fetchRecent / fetchTree', () => {
  it('shows an error on 503 and empties the list', async () => {
    mockGet.mockRejectedValue(new ApiError(503, 'down'))
    const { result } = renderHook(() => useKnightSession())
    await act(() => result.current.fetchRecent('galahad'))
    expect(result.current.recent).toEqual([])
    expect(result.current.error).toMatch(/unavailable/)
    await act(() => result.current.fetchTree('galahad'))
    expect(result.current.tree).toEqual([])
  })

  it('reads entries and nodes', async () => {
    mockGet.mockResolvedValueOnce({ entries: [{ id: 'e' }] }).mockResolvedValueOnce({ nodes: [{ id: 'n' }] })
    const { result } = renderHook(() => useKnightSession())
    await act(() => result.current.fetchRecent('galahad'))
    await act(() => result.current.fetchTree('galahad'))
    expect(result.current.recent).toHaveLength(1)
    expect(result.current.tree).toHaveLength(1)
  })
})
