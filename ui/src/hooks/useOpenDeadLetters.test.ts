import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useOpenDeadLetters } from './useOpenDeadLetters'

const apiGet = vi.fn()
vi.mock('../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }))

describe('useOpenDeadLetters', () => {
  it('counts only the selected table, filtering in the browser', async () => {
    apiGet.mockResolvedValue({ deadLetters: [{ taskId: '1', table: 'alpha' }, { taskId: '2', table: 'beta' }, { taskId: '3' }] })
    const all = renderHook(() => useOpenDeadLetters(''))
    await waitFor(() => expect(all.result.current).toBe(3))
    const alpha = renderHook(() => useOpenDeadLetters('alpha'))
    await waitFor(() => expect(alpha.result.current).toBe(1))
    const none = renderHook(() => useOpenDeadLetters('none'))
    await waitFor(() => expect(none.result.current).toBe(1))
    expect(apiGet).toHaveBeenCalledWith('/api/dead-letters?state=open')
  })
})
