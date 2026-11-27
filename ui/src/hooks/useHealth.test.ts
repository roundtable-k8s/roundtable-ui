import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useHealth } from './useHealth'

const apiGet = vi.fn()
vi.mock('../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }))

describe('useHealth', () => {
  afterEach(() => {
    apiGet.mockReset()
    vi.useRealTimers()
  })

  it('is null until the first answer', () => {
    apiGet.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useHealth(60000))
    expect(result.current).toBeNull()
  })

  it('flags a failed poll after a success and keeps the last known state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiGet.mockResolvedValueOnce({ kubernetes: 'ok', nats: 'connected' }).mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useHealth(1000))
    await waitFor(() => expect(result.current?.nats).toBe('connected'))
    expect(result.current?.error).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(result.current?.error).toBe(true))
    expect(result.current?.kubernetes).toBe('ok')
  })

  it('stays null when the first poll fails', async () => {
    apiGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useHealth(60000))
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toBeNull()
  })
})
