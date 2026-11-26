import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { KnightDetailDrawer } from './KnightDetailDrawer'
import type { Knight } from '../hooks/useFleet'

const k = (name: string, over: Partial<Knight> = {}): Knight => ({
  name, domain: 'dev', status: 'online', ready: true, restarts: 0, age: '1h', image: 'img', skills: 0, nixTools: 0, labels: {}, ...over,
})

const resolvers: Record<string, (r: Response) => void> = {}
const fetchMock = vi.fn()

beforeEach(() => {
  for (const key of Object.keys(resolvers)) delete resolvers[key]
  fetchMock.mockReset()
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (/^\/api\/fleet\/[^/]+$/.test(url)) {
      return new Promise<Response>((resolve, reject) => {
        resolvers[url] = resolve
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    return Promise.resolve(new Response('{}', { status: 404 }))
  })
  vi.stubGlobal('fetch', fetchMock)
})

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('KnightDetailDrawer', () => {
  it('follows the live knight object without refetching', async () => {
    const { rerender } = render(<MemoryRouter><KnightDetailDrawer knight={k('galahad', { restarts: 1 })} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('1 restarts')).toBeInTheDocument()
    const calls = fetchMock.mock.calls.length
    rerender(<MemoryRouter><KnightDetailDrawer knight={k('galahad', { restarts: 5 })} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('5 restarts')).toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('reads Starting for a starting knight', () => {
    render(<MemoryRouter><KnightDetailDrawer knight={k('galahad', { status: 'starting', ready: false })} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('Starting')).toBeInTheDocument()
    expect(screen.queryByText('Offline')).not.toBeInTheDocument()
  })

  it("ignores a slow detail response for knight A after B was opened", async () => {
    const { rerender } = render(<MemoryRouter><KnightDetailDrawer knight={k('arthur')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(resolvers['/api/fleet/arthur']).toBeDefined())
    rerender(<MemoryRouter><KnightDetailDrawer knight={k('bors')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(resolvers['/api/fleet/bors']).toBeDefined())
    await act(async () => {
      resolvers['/api/fleet/arthur'](json(k('arthur', { skillsList: ['a-only-skill'] })))
    })
    expect(screen.queryByText('a-only-skill')).not.toBeInTheDocument()
  })

  it('encodes the knight name in the detail URL', async () => {
    render(<MemoryRouter><KnightDetailDrawer knight={k('a/b')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(resolvers['/api/fleet/a%2Fb']).toBeDefined())
  })
})
