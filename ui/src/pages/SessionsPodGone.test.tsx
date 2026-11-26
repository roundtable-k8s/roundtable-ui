import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Link } from 'react-router-dom'
import { SessionsPage } from './Sessions'

vi.mock('../hooks/useFleet', () => ({
  useFleet: () => ({
    knights: [{ name: 'galahad', domain: 'security', status: 'online' }, { name: 'lancelot', domain: 'dev', status: 'online' }],
    loading: false, error: null, refresh: () => {},
  }),
}))

// Per-URL responses for the introspect API.
let routes: Record<string, () => Response>
// When set, history requests for galahad wait for it (to simulate a slow first fetch).
let historyGate: Promise<void> | null = null
const calls: string[] = []
vi.mock('../lib/api', () => ({
  apiFetch: (url: string) => {
    calls.push(url)
    if (historyGate && url.includes('/galahad/session?type=history')) {
      return historyGate.then(() => new Response(JSON.stringify(history), { status: 200 }))
    }
    for (const [prefix, make] of Object.entries(routes)) {
      if (url.includes(prefix)) return Promise.resolve(make())
    }
    return Promise.resolve(new Response('{}', { status: 200 }))
  },
}))

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status })
const history = {
  sessions: [
    { id: 's-old', pod: 'galahad-b', runId: 'run-1', startedAt: '2026-11-24T09:00:00Z', entryCount: 3, messageCount: 2, firstPrompt: 'old', sizeBytes: null },
    { id: 's-new', pod: 'galahad-a', runId: 'run-1', startedAt: '2026-11-24T10:00:00Z', entryCount: 3, messageCount: 2, firstPrompt: 'new', sizeBytes: null },
    { id: 's-gone', pod: 'galahad-c', runId: 'run-2', startedAt: '2026-11-24T08:00:00Z', entryCount: 3, messageCount: 2, firstPrompt: 'gone', sizeBytes: null },
  ],
}

function renderPage(url = '/sessions?knight=galahad') {
  return render(<MemoryRouter initialEntries={[url]}><SessionsPage /></MemoryRouter>)
}

beforeEach(() => {
  historyGate = null
  calls.length = 0
  routes = {
    'type=history': json(history),
    'pod=galahad-c': json({ error: 'pod gone', podGone: true, pod: 'galahad-c' }, 410),
    'type=session&id=s-new&pod=galahad-a': json({ entries: [{ id: 'e1', parentId: null, type: 'message', role: 'user', text: 'hello from a', timestamp: '2026-11-24T10:00:00Z' }], total: 1 }),
  }
})

describe('Sessions page: run → pod grouping and pod-gone state (#220)', () => {
  it('groups the picker by run and pod', async () => {
    renderPage()
    const picker = await screen.findByLabelText('Session')
    await within(picker).findByRole('group', { name: 'Run run-1 · pod galahad-a' })
    const groups = within(picker).getAllByRole('group').map(g => g.getAttribute('label'))
    expect(groups).toEqual(['Run run-1 · pod galahad-a', 'Run run-1 · pod galahad-b', 'Run run-2 · pod galahad-c'])
  })

  it('fetches a session from its own pod', async () => {
    renderPage()
    const picker = await screen.findByLabelText('Session')
    await within(picker).findByRole('group', { name: 'Run run-1 · pod galahad-a' })
    await userEvent.selectOptions(picker, 'galahad-a/s-new')
    expect(await screen.findByText('hello from a')).toBeInTheDocument()
    expect(calls.some(u => u.includes('type=session&id=s-new&pod=galahad-a'))).toBe(true)
  })

  it('shows "pod gone" when the session\'s pod has been scaled away', async () => {
    renderPage()
    const picker = await screen.findByLabelText('Session')
    await within(picker).findByRole('group', { name: 'Run run-2 · pod galahad-c' })
    await userEvent.selectOptions(picker, 'galahad-c/s-gone')
    const notice = await screen.findByRole('status', { name: /^(?!Loading)/ })
    expect(notice).toHaveTextContent('Pod gone')
    expect(notice).toHaveTextContent('galahad-c')
    expect(within(notice).getByRole('link', { name: 'Running' })).toHaveAttribute('href', '/running')
    expect(screen.queryByText('This archived session has no entries.')).not.toBeInTheDocument()
  })

  it('opens the linked pod+run session from a deep link', async () => {
    renderPage('/sessions?knight=galahad&pod=galahad-a&runId=run-1')
    expect(await screen.findByText('hello from a')).toBeInTheDocument()
    expect((screen.getByLabelText('Session') as HTMLSelectElement).value).toBe('galahad-a/s-new')
  })

  it('shows "pod gone" for a deep link to a scaled-away pod with no listed session', async () => {
    routes['type=history'] = json({ sessions: [] })
    routes['pod=galahad-z'] = json({ error: 'pod gone', podGone: true, pod: 'galahad-z' }, 410)
    renderPage('/sessions?knight=galahad&pod=galahad-z&runId=run-9')
    const notice = await screen.findByRole('status', { name: /^(?!Loading)/ })
    expect(notice).toHaveTextContent('galahad-z')
  })

  it('does not show "pod gone" for a 410 without podGone: true', async () => {
    routes['type=history'] = json({ sessions: [] })
    routes['pod=galahad-z'] = () => new Response('gone', { status: 410 })
    renderPage('/sessions?knight=galahad&pod=galahad-z&runId=run-9')
    const notice = await screen.findByRole('status', { name: /^(?!Loading)/ })
    expect(notice).toHaveTextContent('Could not reach pod galahad-z to check')
    expect(notice).not.toHaveTextContent('No session found')
    expect(screen.queryByText(/Pod gone/i)).toBeNull()
  })

  it('does not claim "No session found" when the probe fails', async () => {
    routes['type=history'] = json({ sessions: [] })
    routes['pod=galahad-z'] = () => new Response('boom', { status: 500 })
    renderPage('/sessions?knight=galahad&pod=galahad-z&runId=run-9')
    const notice = await screen.findByRole('status', { name: /^(?!Loading)/ })
    expect(notice).toHaveTextContent('Could not reach pod galahad-z to check; showing the live session.')
    expect(screen.queryByText(/No session found/)).toBeNull()
  })

  it('keeps the user\'s knight choice when switching before the first deep-link fetch resolves', async () => {
    const user = userEvent.setup()
    let release!: () => void
    historyGate = new Promise<void>(r => { release = r })
    renderPage('/sessions?knight=galahad&pod=galahad-a&runId=run-1')
    const knightSelect = screen.getByLabelText('Knight') as HTMLSelectElement
    expect(knightSelect.value).toBe('galahad')
    await user.selectOptions(knightSelect, 'lancelot')
    release()
    await vi.waitFor(() => expect(calls.some(u => u.includes('/lancelot/session?type=history'))).toBe(true))
    await new Promise(r => setTimeout(r, 20))
    expect((screen.getByLabelText('Knight') as HTMLSelectElement).value).toBe('lancelot')
  })

  it('tells the user when a deep link finds no session on a live pod', async () => {
    routes['type=history'] = json({ sessions: [] })
    routes['pod=galahad-live'] = json({ session: null })
    renderPage('/sessions?knight=galahad&pod=galahad-live')
    expect(await screen.findByRole('status', { name: /^(?!Loading)/ })).toHaveTextContent('No session found for pod galahad-live')
  })

  it('re-applies the deep link when the URL changes without a remount', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/sessions?knight=galahad&pod=galahad-a&runId=run-1']}>
        <Link to="/sessions?knight=galahad&pod=galahad-c&runId=run-2">next</Link>
        <SessionsPage />
      </MemoryRouter>,
    )
    const picker = await screen.findByLabelText('Session')
    await within(picker).findByRole('group', { name: 'Run run-2 · pod galahad-c' })
    await vi.waitFor(() => expect(calls.some(u => u.includes('type=session&id=s-new&pod=galahad-a'))).toBe(true))
    await user.click(screen.getByText('next'))
    expect(await screen.findByRole('status', { name: /^(?!Loading)/ })).toHaveTextContent('galahad-c')
  })
})

describe('Sessions page: accessible names', () => {
  it('labels the knight picker and the search inputs', async () => {
    renderPage()
    expect(await screen.findByLabelText('Knight')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter knights')).toBeInTheDocument()
    expect(screen.getByLabelText('Search entries')).toBeInTheDocument()
  })
})
