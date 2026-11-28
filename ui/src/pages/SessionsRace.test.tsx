import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { SessionsPage } from './Sessions'

const fleet = vi.hoisted(() => ({
  state: { knights: [] as unknown[], loading: false, error: null as string | null, refresh: (() => {}) as () => void },
}))
vi.mock('../hooks/useFleet', () => ({ useFleet: () => fleet.state }))

const pending: Record<string, (r: Response) => void> = {}
vi.mock('../lib/api', async () => {
  const { ApiError } = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  const apiFetch = (url: string) => {
    const m = url.match(/fleet\/([^/]+)\/session\?type=(\w+)/)
    if (m && m[2] === 'recent') return new Promise<Response>(res => { pending[m[1]] = res })
    if (m && m[2] === 'stats') {
      const n = m[1] === 'galahad' ? 111 : 222
      return Promise.resolve(new Response(JSON.stringify({ knight: m[1], session: { sessionId: 's', userMessages: 1, assistantMessages: 1, totalMessages: n, toolCalls: 1, tokens: { input: 1, output: 1, total: 2 }, cost: 0 }, runtime: { uptime: 1, activeTasks: 0, model: 'm' } }), { status: 200 }))
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  }
  // Same contract as the real apiGet: parse JSON, throw ApiError on non-2xx.
  const apiGet = async (url: string) => {
    const res = await apiFetch(url) as Response
    if (!res.ok) throw new ApiError(res.status, `${res.status}`)
    return res.json()
  }
  return { apiFetch, apiGet, ApiError }
})

const answer = (text: string) => new Response(JSON.stringify({ entries: [{ id: text, parentId: null, type: 'message', role: 'user', text, timestamp: '2026-11-24T10:00:00Z' }] }), { status: 200 })

beforeEach(() => {
  for (const k of Object.keys(pending)) delete pending[k]
  fleet.state = {
    knights: [{ name: 'galahad', domain: 'security', status: 'online' }, { name: 'lancelot', domain: 'dev', status: 'online' }],
    loading: false, error: null, refresh: () => {},
  }
})

const renderPage = () => render(<MemoryRouter initialEntries={['/sessions?knight=galahad']}><SessionsPage /></MemoryRouter>)

describe('Sessions page knight switching (#641)', () => {
  it('keeps the newest knight\'s rows when answers arrive out of order', async () => {
    renderPage()
    await waitFor(() => expect(pending.galahad).toBeDefined())
    fireEvent.change(screen.getByLabelText('Knight'), { target: { value: 'lancelot' } })
    await waitFor(() => expect(pending.lancelot).toBeDefined())
    await act(async () => { pending.lancelot(answer('from lancelot')) })
    await screen.findByText('from lancelot')
    await act(async () => { pending.galahad(answer('from galahad')) })
    expect(screen.getByText('from lancelot')).toBeInTheDocument()
    expect(screen.queryByText('from galahad')).not.toBeInTheDocument()
  })

  it('hides the previous knight\'s stats immediately on switch', async () => {
    renderPage()
    await screen.findByText('111')
    fireEvent.change(screen.getByLabelText('Knight'), { target: { value: 'lancelot' } })
    expect(screen.queryByText('111')).not.toBeInTheDocument()
    await screen.findByText('222')
  })

  it('keeps the selected knight in the options while the filter hides it', async () => {
    renderPage()
    await waitFor(() => expect(pending.galahad).toBeDefined())
    fireEvent.change(screen.getByLabelText('Filter knights'), { target: { value: 'dev' } })
    const select = screen.getByLabelText('Knight') as HTMLSelectElement
    expect(select.value).toBe('galahad')
    expect(Array.from(select.options).map(o => o.value)).toEqual(['galahad', 'lancelot'])
  })

  it('shows an error with Retry when the fleet request failed', async () => {
    const refresh = vi.fn()
    fleet.state = { knights: [], loading: false, error: 'boom', refresh }
    renderPage()
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
    expect(screen.queryByText('No knights available in the fleet')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(refresh).toHaveBeenCalled()
  })
})
