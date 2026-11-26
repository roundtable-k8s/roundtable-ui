import { describe, it, expect, vi } from 'vitest'
import { fetchChainTotal, truncationNote } from './chainTotal'
import { apiFetch } from './api'

vi.mock('./api', () => ({ apiFetch: vi.fn() }))

describe('chainTotal', () => {
  it('reads X-Total-Count from a one-item page', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('[]', { headers: { 'X-Total-Count': '731' } }))
    expect(await fetchChainTotal('/api/chains?copies=exclude&limit=500&table=a')).toBe(731)
    expect(apiFetch).toHaveBeenCalledWith('/api/chains?copies=exclude&limit=1&table=a')
  })
  it('is null on failure or a missing header', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('[]'))
    expect(await fetchChainTotal('/api/chains?limit=500')).toBeNull()
    vi.mocked(apiFetch).mockRejectedValue(new Error('x'))
    expect(await fetchChainTotal('/api/chains?limit=500')).toBeNull()
  })
  it('notes only when cut short', () => {
    expect(truncationNote(500, 731)).toBe('showing 500 of 731')
    expect(truncationNote(500, 500)).toBeNull()
    expect(truncationNote(12, null)).toBeNull()
  })
})
