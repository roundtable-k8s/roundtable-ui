import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { OvernightPage } from './Overnight'

const NOW = Date.parse('2026-03-10T08:00:00Z')
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString()

const chains = [
  { name: 'ok-run', namespace: 'ns', phase: 'Succeeded', completionTime: ago(2), costUSD: '1.25', notionalCostUSD: '0.25' },
  { name: 'bad-run', namespace: 'ns', phase: 'Failed', completionTime: ago(3), costUSD: '0.75' },
  { name: 'day-old', namespace: 'ns', phase: 'Failed', completionTime: ago(20), costUSD: '2' },
]
const deadLetters = { deadLetters: [{ taskId: 't1', knight: 'galahad', state: 'open', reason: 'timeout', attempt: 1, deadLetteredAt: ago(1), updatedAt: ago(1) }] }
const schedules = { schedules: [
  { name: 'nightly', namespace: 'ops', lastRunAt: ago(4), lastResult: { time: ago(4), outcome: 'failed' } },
  { name: 'old', namespace: 'ops', lastRunAt: ago(30), lastResult: { time: ago(30), outcome: 'succeeded' } },
] }

let fail: string | null = null
const respond = (url: string) => {
  if (fail && url.startsWith(fail)) return Promise.resolve(new Response('boom', { status: 500 }))
  const body = url.startsWith('/api/chains') ? chains : url.startsWith('/api/dead-letters') ? deadLetters : schedules
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }))
}

function Loc() { return <div data-testid="loc">{useLocation().search}</div> }
const renderPage = (url = '/overnight') =>
  render(<MemoryRouter initialEntries={[url]}><OvernightPage /><Loc /></MemoryRouter>)

beforeEach(() => {
  fail = null
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => respond(String(input))))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const stat = (label: string) => screen.getAllByText(label)[0].closest('div')!.parentElement!

describe('OvernightPage', () => {
  it('summarises the default 12 hour window', async () => {
    renderPage()
    expect(await screen.findByRole('link', { name: 'bad-run' })).toHaveAttribute('href', '/chains?chain=bad-run')
    expect(screen.queryByRole('link', { name: 'day-old' })).toBeNull()
    expect(within(stat('Runs finished')).getByText('2')).toBeInTheDocument()
    expect(within(stat('Succeeded')).getByText('1')).toBeInTheDocument()
    expect(within(stat('Failed')).getByText('1')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'galahad' })).toHaveAttribute('href', '/failed')
    expect(screen.getByRole('link', { name: 'nightly' })).toHaveAttribute('href', '/schedules/ops/nightly')
    expect(screen.queryByRole('link', { name: 'old' })).toBeNull()
  })

  it('reads ?since= and widens the window', async () => {
    renderPage('/overnight?since=24h')
    expect(await screen.findByRole('link', { name: 'day-old' })).toBeInTheDocument()
    expect(within(stat('Failed')).getByText('2')).toBeInTheDocument()
  })

  it('writes since to the URL when changed', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) })
    renderPage()
    await screen.findByRole('link', { name: 'bad-run' })
    await user.selectOptions(screen.getByLabelText('Since'), '24h')
    expect(screen.getByTestId('loc')).toHaveTextContent('?since=24h')
    expect(await screen.findByRole('link', { name: 'day-old' })).toBeInTheDocument()
  })

  it('shows an error for the failing endpoint only', async () => {
    fail = '/api/dead-letters'
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Dead letters')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    await waitFor(() => expect(screen.getByRole('link', { name: 'bad-run' })).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'nightly' })).toBeInTheDocument()
  })
})

describe('OvernightPage truncated chain list', () => {
  it('reads the total from the list response with one chains request', async () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ name: `c-${i}`, namespace: 'ns', phase: 'Succeeded', completionTime: ago(2) }))
    const fetchMock = vi.fn((input: RequestInfo | URL) => String(input).startsWith('/api/chains')
      ? Promise.resolve(new Response(JSON.stringify(many), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Total-Count': '731' } }))
      : respond(String(input)))
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    expect(await screen.findByText(/showing 500 of 731/)).toBeInTheDocument()
    expect(fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/chains')).length).toBe(1)
  })
})
