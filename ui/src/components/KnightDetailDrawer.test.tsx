import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
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
  it('never grows wider than the screen', () => {
    render(<MemoryRouter><KnightDetailDrawer knight={k('galahad')} onClose={() => {}} /></MemoryRouter>)
    const drawer = screen.getByRole('dialog', { name: 'galahad details' })
    expect(drawer.className).toContain('w-full')
    expect(drawer.className).toContain('max-w-[520px]')
  })

  it('follows the live knight object without refetching', async () => {
    const { rerender } = render(<MemoryRouter><KnightDetailDrawer knight={k('galahad', { restarts: 1 })} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('1 restarts')).toBeInTheDocument()
    const calls = fetchMock.mock.calls.length
    rerender(<MemoryRouter><KnightDetailDrawer knight={k('galahad', { restarts: 5 })} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('5 restarts')).toBeInTheDocument()
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('labels the age as uptime when ready and age when not ready', () => {
    const { rerender } = render(<MemoryRouter><KnightDetailDrawer knight={k('galahad', { age: '2h 15m' })} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('2h 15m uptime')).toBeInTheDocument()
    rerender(<MemoryRouter><KnightDetailDrawer knight={k('galahad', { age: '2h 15m', ready: false, status: 'offline' })} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText('2h 15m age')).toBeInTheDocument()
  })

  it('uses startedAt for the uptime of a ready knight and createdAt for age', () => {
    const now = Date.now()
    const over = { age: '9h', createdAt: new Date(now - 9 * 3600_000).toISOString(), startedAt: new Date(now - 2 * 3600_000).toISOString() }
    const { rerender } = render(<MemoryRouter><KnightDetailDrawer knight={k('galahad', over)} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText(/^2h.* uptime$/)).toBeInTheDocument()
    rerender(<MemoryRouter><KnightDetailDrawer knight={k('galahad', { ...over, ready: false, status: 'offline' })} onClose={() => {}} /></MemoryRouter>)
    expect(screen.getByText(/^9h.* age$/)).toBeInTheDocument()
  })

  it('shows a False WorkspaceSnapshots condition and its message with zero snapshots', async () => {
    render(<MemoryRouter><KnightDetailDrawer knight={k('kay')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(resolvers['/api/fleet/kay']).toBeDefined())
    await act(async () => {
      resolvers['/api/fleet/kay'](json(k('kay', { workspaceSnapshots: [], workspaceSnapshotsCondition: { status: 'False', reason: 'SnapshotFailed', message: 'volume snapshot class missing' } })))
    })
    expect(screen.getByText(/Workspace snapshots \(0\)/)).toBeInTheDocument()
    expect(screen.getByText(/WorkspaceSnapshots: False \(SnapshotFailed\)/)).toBeInTheDocument()
    expect(screen.getByText('volume snapshot class missing')).toHaveClass('text-amber-300')
  })

  it('shows a True WorkspaceSnapshots condition message in gray, not amber', async () => {
    render(<MemoryRouter><KnightDetailDrawer knight={k('kay')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(resolvers['/api/fleet/kay']).toBeDefined())
    await act(async () => {
      resolvers['/api/fleet/kay'](json(k('kay', { workspaceSnapshots: [], workspaceSnapshotsCondition: { status: 'True', reason: 'Ready', message: 'all snapshots ready' } })))
    })
    const msg = screen.getByText('all snapshots ready')
    expect(msg).toHaveClass('text-gray-400')
    expect(msg).not.toHaveClass('text-amber-300')
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

  it("does not show knight A's stats under knight B", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/fleet/arthur/session?type=stats')) {
        return Promise.resolve(json({ knight: 'arthur', session: null, runtime: { uptime: 5, activeTasks: 0, model: 'a-model' } }))
      }
      if (url.includes('/session')) {
        return new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))
      }
      return new Promise<Response>(() => {})
    })
    const { rerender } = render(<MemoryRouter><KnightDetailDrawer knight={k('arthur')} onClose={() => {}} /></MemoryRouter>)
    expect(await screen.findByText('a-model')).toBeInTheDocument()
    rerender(<MemoryRouter><KnightDetailDrawer knight={k('bors')} onClose={() => {}} /></MemoryRouter>)
    expect(screen.queryByText('a-model')).not.toBeInTheDocument()
  })

  it('encodes the knight name in the detail URL', async () => {
    render(<MemoryRouter><KnightDetailDrawer knight={k('a/b')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(resolvers['/api/fleet/a%2Fb']).toBeDefined())
  })

  it('lists workspace snapshots with ready state and shows No snapshots yet when empty', async () => {
    const { unmount } = render(<MemoryRouter><KnightDetailDrawer knight={k('arthur')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(resolvers['/api/fleet/arthur']).toBeDefined())
    await act(async () => { resolvers['/api/fleet/arthur'](json(k('arthur', { workspaceSnapshots: [] }))) })
    expect(screen.getByText('No snapshots yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Take snapshot/ })).toBeInTheDocument()
    unmount()

    render(<MemoryRouter><KnightDetailDrawer knight={k('bors')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(resolvers['/api/fleet/bors']).toBeDefined())
    await act(async () => {
      resolvers['/api/fleet/bors'](json(k('bors', { workspaceSnapshots: [
        { name: 'snap-a', createdAt: '2026-01-01T00:00:00Z', readyToUse: true },
        { name: 'snap-b', createdAt: '2026-02-01T00:00:00Z', readyToUse: false },
      ] })))
    })
    expect(screen.getByText(/Workspace snapshots \(2\)/)).toBeInTheDocument()
    expect(screen.getByText('snap-a')).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
    expect(screen.getByText('spec.workspace.fromSnapshot')).toBeInTheDocument()
  })

  it('shows a failed detail request with a Retry that reloads the details', async () => {
    let detailCalls = 0
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/fleet/arthur') {
        detailCalls++
        return detailCalls === 1
          ? Promise.reject(new TypeError('network down'))
          : Promise.resolve(json(k('arthur', { workspaceSnapshots: [] })))
      }
      return new Promise<Response>(() => {})
    })
    render(<MemoryRouter><KnightDetailDrawer knight={k('arthur')} onClose={() => {}} /></MemoryRouter>)
    expect(await screen.findByText(/Could not load the knight's details: network down/)).toBeInTheDocument()
    expect(screen.queryByText('No snapshots yet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('No snapshots yet')).toBeInTheDocument()
    expect(screen.queryByText(/Could not load the knight's details/)).not.toBeInTheDocument()
    expect(detailCalls).toBe(2)
  })

  it("keeps the activity spinner until the latest knight's recent request answers", async () => {
    const recentResolvers: Record<string, (r: Response) => void> = {}
    fetchMock.mockImplementation((url: string) => {
      const m = /^\/api\/fleet\/([^/]+)\/session\?type=recent/.exec(url)
      if (m) return new Promise<Response>((resolve) => { recentResolvers[m[1]] = resolve })
      return new Promise<Response>(() => {})
    })
    const { rerender } = render(<MemoryRouter><KnightDetailDrawer knight={k('arthur')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(recentResolvers['arthur']).toBeDefined())
    rerender(<MemoryRouter><KnightDetailDrawer knight={k('bors')} onClose={() => {}} /></MemoryRouter>)
    await waitFor(() => expect(recentResolvers['bors']).toBeDefined())
    // Knight A's answer arrives late and is stale: the spinner must stay for B.
    await act(async () => { recentResolvers['arthur'](json({ entries: [] })) })
    expect(screen.getByText('Loading activity...')).toBeInTheDocument()
    await act(async () => { recentResolvers['bors'](json({ entries: [] })) })
    expect(screen.queryByText('Loading activity...')).not.toBeInTheDocument()
  })
})
