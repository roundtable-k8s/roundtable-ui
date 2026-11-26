import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useOpenDeadLetters, deadLetterBadge } from './useOpenDeadLetters'

const apiGet = vi.fn()
vi.mock('../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }))

describe('useOpenDeadLetters', () => {
  it('counts only the selected table, filtering in the browser', async () => {
    apiGet.mockResolvedValue({ deadLetters: [{ taskId: '1', table: 'alpha' }, { taskId: '2', table: 'beta' }, { taskId: '3' }] })
    const all = renderHook(() => useOpenDeadLetters(''))
    await waitFor(() => expect(all.result.current.count).toBe(3))
    const alpha = renderHook(() => useOpenDeadLetters('alpha'))
    await waitFor(() => expect(alpha.result.current.count).toBe(1))
    const none = renderHook(() => useOpenDeadLetters('none'))
    await waitFor(() => expect(none.result.current.count).toBe(1))
    expect(apiGet).toHaveBeenCalledWith('/api/dead-letters?state=open')
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
})
