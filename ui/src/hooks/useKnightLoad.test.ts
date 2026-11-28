import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useKnightLoad, parseKnightLoad } from './useKnightLoad'
import { apiGet, ApiError } from '../lib/api'
import { namespacedKey } from '../lib/keys'

vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), apiGet: vi.fn() }))
const mockGet = vi.mocked(apiGet)

beforeEach(() => { mockGet.mockReset() })

describe('parseKnightLoad', () => {
  it('reads {knights} and bare lists, keyed by namespace/name, skipping knights without queue', () => {
    const body = { knights: [
      { name: 'galahad', namespace: 'prod', queue: { pending: 2, inFlight: 1 } },
      { name: 'kay', queue: { pending: 0, inFlight: 0 } },
      { name: 'patsy' },
      { name: 'bad', queue: { pending: 'x', inFlight: 0 } },
    ] }
    const map = parseKnightLoad(body)
    expect([...map.keys()]).toEqual(['prod/galahad', '/kay'])
    expect(map.get('prod/galahad')).toEqual({ pending: 2, inFlight: 1 })
    expect(parseKnightLoad([{ name: 'kay', queue: { pending: 1, inFlight: 0 } }]).get('/kay')).toEqual({ pending: 1, inFlight: 0 })
    expect(parseKnightLoad(null).size).toBe(0)
    expect(namespacedKey({ name: 'kay' })).toBe('/kay')
  })
})

describe('useKnightLoad', () => {
  it('returns the queue counts from /api/chat/knights?load=true', async () => {
    mockGet.mockResolvedValue({ knights: [{ name: 'galahad', queue: { pending: 2, inFlight: 1 } }] })
    const { result } = renderHook(() => useKnightLoad())
    await waitFor(() => expect(result.current.get('/galahad')).toEqual({ pending: 2, inFlight: 1 }))
    expect(mockGet.mock.calls[0][0]).toBe('/api/chat/knights?load=true')
  })

  it('gives an empty map on an error, without throwing', async () => {
    mockGet.mockRejectedValue(new ApiError(503, 'gateway not configured'))
    const { result } = renderHook(() => useKnightLoad())
    await waitFor(() => expect(mockGet).toHaveBeenCalled())
    await waitFor(() => expect(result.current.size).toBe(0))
  })
})
