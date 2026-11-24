import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiError } from '../lib/api'
import { useRunning } from './useRunning'

let listener: ((data: unknown) => void) | null = null
const wsState = {
  connected: true,
  subscribeTopic: vi.fn((_topic: string, fn: (data: unknown) => void) => {
    listener = fn
    return () => { listener = null }
  }),
}
vi.mock('./useWebSocket', () => ({ useWebSocket: () => wsState }))

const apiGet = vi.fn()
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiGet: (...args: unknown[]) => apiGet(...args),
}))

const t = (taskId: string, status = 'running') => ({ taskId, knight: 'galahad', status, startedAt: '2026-11-24T10:00:00Z' })

beforeEach(() => {
  listener = null
  apiGet.mockReset()
})

describe('useRunning', () => {
  it('loads the snapshot then applies running deltas', async () => {
    apiGet.mockResolvedValue({ tasks: [t('a')] })
    const { result } = renderHook(() => useRunning())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenCalledWith('/api/running', expect.anything())
    expect([...result.current.tasks.keys()]).toEqual(['a'])

    act(() => listener!({ op: 'upsert', task: t('b') }))
    expect([...result.current.tasks.keys()].sort()).toEqual(['a', 'b'])
    act(() => listener!({ op: 'upsert', task: t('a', 'lost') }))
    expect(result.current.tasks.get('a')!.status).toBe('lost')
    act(() => listener!({ op: 'remove', taskId: 'b' }))
    expect([...result.current.tasks.keys()]).toEqual(['a'])
    act(() => listener!({ op: 'garbage' }))
    expect(result.current.tasks.size).toBe(1)
  })

  it('does not resurrect a task that finished while the snapshot was loading', async () => {
    let resolve!: (v: unknown) => void
    apiGet.mockReturnValue(new Promise((r) => { resolve = r }))
    const { result } = renderHook(() => useRunning())
    act(() => listener!({ op: 'remove', taskId: 'a' }))
    act(() => listener!({ op: 'upsert', task: t('c') }))
    await act(async () => { resolve({ tasks: [t('a'), t('b')] }) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect([...result.current.tasks.keys()].sort()).toEqual(['b', 'c'])
  })

  it('flags an API without /api/running as unavailable', async () => {
    apiGet.mockRejectedValue(new ApiError(404, 'not found'))
    const { result } = renderHook(() => useRunning())
    await waitFor(() => expect(result.current.unavailable).toBe(true))
    expect(result.current.error).toBeNull()
  })

  it('surfaces other errors', async () => {
    apiGet.mockRejectedValue(new ApiError(500, 'boom'))
    const { result } = renderHook(() => useRunning())
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })
})
