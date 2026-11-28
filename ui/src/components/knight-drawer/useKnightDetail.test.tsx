import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useKnightDetail } from './useKnightDetail'
import { apiGet } from '../../lib/api'

vi.mock('../../lib/api', () => ({ apiGet: vi.fn() }))

describe('useKnightDetail', () => {
  beforeEach(() => vi.mocked(apiGet).mockReset())

  it('fetches the knight and exposes the detail', async () => {
    vi.mocked(apiGet).mockResolvedValue({ name: 'galahad', skillsList: ['a'] })
    const { result } = renderHook(() => useKnightDetail('galahad'))
    await waitFor(() => expect(result.current.detail?.name).toBe('galahad'))
    expect(apiGet).toHaveBeenCalledWith('/api/fleet/galahad', expect.objectContaining({ signal: expect.anything() }))
    expect(result.current.loading).toBe(false)
  })

  it('reports an error and refreshes on demand', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ name: 'galahad' })
    const { result } = renderHook(() => useKnightDetail('galahad'))
    await waitFor(() => expect(result.current.error).toBe('boom'))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.detail?.name).toBe('galahad'))
    expect(result.current.error).toBeNull()
  })

  it('does not fetch without a knight', () => {
    renderHook(() => useKnightDetail(undefined))
    expect(apiGet).not.toHaveBeenCalled()
  })
})
