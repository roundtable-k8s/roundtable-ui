import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { ApiError } from '../lib/api'
import { useCards } from './useCards'
import { galahadCard, patsyCard } from '../test/fixtures/cards'

let listener: ((data: unknown) => void) | null = null
let subscribedTopic = ''
const wsState = {
  connected: true,
  subscribeTopic: vi.fn((topic: string, fn: (data: unknown) => void) => {
    subscribedTopic = topic
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

beforeEach(() => {
  listener = null
  apiGet.mockReset()
})

describe('useCards', () => {
  it('loads /api/cards then applies cards pushes', async () => {
    apiGet.mockResolvedValue({ cards: [galahadCard] })
    const { result } = renderHook(() => useCards())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(apiGet).toHaveBeenCalledWith('/api/cards', expect.anything())
    expect(subscribedTopic).toBe('cards')
    expect([...result.current.cards.keys()]).toEqual(['personal.galahad'])

    act(() => listener!(patsyCard))
    expect([...result.current.cards.keys()].sort()).toEqual(['personal.galahad', 'personal.patsy'])
    act(() => listener!({ ...galahadCard, live: false }))
    expect(result.current.cards.get('personal.galahad')!.live).toBe(false)
    act(() => listener!({ table: 'personal', knight: 'patsy', deleted: true }))
    expect([...result.current.cards.keys()]).toEqual(['personal.galahad'])
    act(() => listener!('garbage'))
    expect(result.current.cards.size).toBe(1)
  })

  it('replays pushes that arrive while the snapshot loads', async () => {
    let resolve!: (v: unknown) => void
    apiGet.mockReturnValue(new Promise((r) => { resolve = r }))
    const { result } = renderHook(() => useCards())
    act(() => listener!({ table: 'personal', knight: 'galahad', deleted: true }))
    act(() => listener!(patsyCard))
    await act(async () => { resolve({ cards: [galahadCard] }) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect([...result.current.cards.keys()]).toEqual(['personal.patsy'])
  })

  it('treats a missing endpoint as no cards, without an error', async () => {
    apiGet.mockRejectedValue(new ApiError(404, 'not found'))
    const { result } = renderHook(() => useCards())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.unavailable).toBe(true)
    expect(result.current.cards.size).toBe(0)
  })
})
