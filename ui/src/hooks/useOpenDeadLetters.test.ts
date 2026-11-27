import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { ApiError } from '../lib/api'
import { useOpenDeadLetters, deadLetterBadge } from './useOpenDeadLetters'

const apiGet = vi.fn()
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiGet: (...a: unknown[]) => apiGet(...a),
}))

describe('useOpenDeadLetters', () => {
  it('counts only the selected table, filtering in the browser', async () => {
    apiGet.mockResolvedValue({ deadLetters: [{ taskId: '1', table: 'alpha' }, { taskId: '2', table: 'beta' }, { taskId: '3' }] })
    const all = renderHook(() => useOpenDeadLetters(''))
    await waitFor(() => expect(all.result.current.count).toBe(3))
    const alpha = renderHook(() => useOpenDeadLetters('alpha'))
    await waitFor(() => expect(alpha.result.current.count).toBe(1))
    const none = renderHook(() => useOpenDeadLetters('none'))
    await waitFor(() => expect(none.result.current.count).toBe(1))
    expect(apiGet).toHaveBeenCalledWith('/api/dead-letters?state=open', expect.objectContaining({ signal: expect.anything() }))
  })

  it('flags a capped list and exposes the real total when reported', async () => {
    const list = Array.from({ length: 100 }, (_, i) => ({ taskId: String(i) }))
    apiGet.mockResolvedValue({ deadLetters: list, total: 137 })
    const { result } = renderHook(() => useOpenDeadLetters(''))
    await waitFor(() => expect(result.current.capped).toBe(true))
    expect(deadLetterBadge(result.current)).toEqual({ text: '100+', title: '137 open (showing 100+)' })
  })

  it('badge shows the plain count when not capped', () => {
    expect(deadLetterBadge({ count: 3, capped: false })).toEqual({ text: '3', title: '3 open' })
    expect(deadLetterBadge({ count: 100, capped: true }).title).toMatch(/100 or more open/)
  })

  it('is loading, not zero, until the first answer', async () => {
    apiGet.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useOpenDeadLetters(''))
    expect(result.current.loading).toBe(true)
    apiGet.mockResolvedValue({ deadLetters: [] })
    const done = renderHook(() => useOpenDeadLetters(''))
    await waitFor(() => expect(done.result.current.loading).toBe(false))
  })

  it('flags an error instead of silently reporting zero', async () => {
    apiGet.mockRejectedValue(new Error('boom'))
    const { result } = renderHook(() => useOpenDeadLetters(''))
    await waitFor(() => expect(result.current.error).toBe(true))
    expect(result.current.count).toBe(0)
    expect(deadLetterBadge(result.current)).toEqual({ text: '?', title: 'dead-letter count unavailable' })
  })

  it('treats 503 (gateway not configured) as nothing to count, not an error', async () => {
    apiGet.mockRejectedValue(new ApiError(503, 'Gateway not configured (set GATEWAY_URL)'))
    const { result } = renderHook(() => useOpenDeadLetters(''))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBeUndefined()
    expect(deadLetterBadge(result.current).text).toBe('0')
  })

  it('treats 502 (gateway unreachable) as an error', async () => {
    apiGet.mockRejectedValue(new ApiError(502, 'Gateway unreachable'))
    const { result } = renderHook(() => useOpenDeadLetters(''))
    await waitFor(() => expect(result.current.error).toBe(true))
  })

  it('clears the error once a poll succeeds again', async () => {
    apiGet.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ deadLetters: [{ taskId: '1' }] })
    const { result } = renderHook(() => useOpenDeadLetters('', 20))
    await waitFor(() => expect(result.current.count).toBe(1))
    expect(result.current.error).toBeUndefined()
  })
})

describe('useOpenDeadLetters polling', () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('makes no requests on a hidden tab and refetches once when visible', async () => {
    vi.useFakeTimers()
    apiGet.mockReset()
    apiGet.mockResolvedValue({ deadLetters: [] })
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    renderHook(() => useOpenDeadLetters(''))
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(apiGet).not.toHaveBeenCalled()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(apiGet).toHaveBeenCalledTimes(1)
  })
})
