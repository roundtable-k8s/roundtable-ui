import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { useMissions } from './useMissions'

const fetchMock = vi.fn()
const wrapper = (search = '') => ({ children }: { children: ReactNode }) =>
  createElement(MemoryRouter, { initialEntries: ['/missions' + search] }, children)
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init)

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('useMissions', () => {
  it('loads the missions', async () => {
    fetchMock.mockResolvedValue(json([{ name: 'm1' }, { name: 'm2' }]))
    const { result } = renderHook(() => useMissions(60_000), { wrapper: wrapper() })
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.missions.map((m) => m.name)).toEqual(['m1', 'm2'])
    expect(result.current.error).toBeNull()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/missions')
  })

  it('narrows the request to the selected table', async () => {
    fetchMock.mockResolvedValue(json([]))
    renderHook(() => useMissions(60_000), { wrapper: wrapper('?table=alpha') })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/missions?table=alpha')
  })

  it('reports an error answer and keeps an empty list', async () => {
    fetchMock.mockResolvedValue(new Response('gateway down', { status: 502, statusText: 'Bad Gateway' }))
    const { result } = renderHook(() => useMissions(60_000), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.error).toBe('gateway down'))
    expect(result.current.missions).toEqual([])
    expect(result.current.loading).toBe(false)
  })
})
