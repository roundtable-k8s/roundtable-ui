import { describe, it, expect, vi } from 'vitest'
import { totalFor, truncationNote } from './chainTotal'
import { apiGetWithTotal } from './api'

describe('chainTotal', () => {
  it('only returns a stored total for the URL it was read for', () => {
    const stored = { url: '/api/chains?table=a', total: 731 }
    expect(totalFor(stored, '/api/chains?table=a')).toBe(731)
    expect(totalFor(stored, '/api/chains?table=b')).toBeNull()
    expect(totalFor(null, '/api/chains?table=a')).toBeNull()
  })
  it('notes only when cut short', () => {
    expect(truncationNote(500, 731)).toBe('showing 500 of 731')
    expect(truncationNote(500, 500)).toBeNull()
    expect(truncationNote(12, null)).toBeNull()
  })
})

describe('apiGetWithTotal', () => {
  const stub = (res: Response) => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(res)))
  it('returns items and X-Total-Count from one request', async () => {
    stub(new Response('[1,2]', { headers: { 'X-Total-Count': '731' } }))
    expect(await apiGetWithTotal('/api/chains?limit=500')).toEqual({ items: [1, 2], total: 731 })
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
  it('total is null when the header is missing or invalid', async () => {
    stub(new Response('[]'))
    expect((await apiGetWithTotal('/x')).total).toBeNull()
    stub(new Response('[]', { headers: { 'X-Total-Count': 'abc' } }))
    expect((await apiGetWithTotal('/x')).total).toBeNull()
    vi.unstubAllGlobals()
  })
  it('throws on non-2xx', async () => {
    stub(new Response('boom', { status: 500 }))
    await expect(apiGetWithTotal('/x')).rejects.toThrow()
    vi.unstubAllGlobals()
  })
})
