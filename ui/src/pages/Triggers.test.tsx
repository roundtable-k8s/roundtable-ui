import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TriggersPage, TriggerDetailPage } from './Triggers'
import { apiGet } from '../lib/api'
import type { Trigger } from '../lib/triggers'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))
const mockApiGet = vi.mocked(apiGet)

function trig(over: Partial<Trigger>): Trigger {
  return {
    name: 't', namespace: 'roundtable', source: { type: 'schedule', detail: '0 3 * * *' },
    targetChain: 'nightly-scan', concurrencyPolicy: 'Allow', suspended: false,
    recentFirings: [], activeRuns: [], conditions: [], ready: 'true', ...over,
  }
}

const three: Trigger[] = [
  trig({ name: 'nightly', activeRuns: ['run-1'], lastFiredAt: new Date().toISOString() }),
  trig({ name: 'on-event', source: { type: 'nats', detail: 'events.deploy' }, ready: 'false' }),
  trig({ name: 'hook', source: { type: 'webhook', detail: 'push · webhook, hmac auth' }, suspended: true }),
]

beforeEach(() => mockApiGet.mockReset())

describe('TriggersPage', () => {
  it('shows the empty state with a docs link when there are no triggers', async () => {
    mockApiGet.mockResolvedValue([])
    render(<MemoryRouter><TriggersPage /></MemoryRouter>)
    const empty = await screen.findByTestId('list-empty')
    expect(empty).toHaveTextContent('A Trigger starts a Chain')
    expect(within(empty).getByRole('link', { name: /docs/i })).toHaveAttribute('href', expect.stringContaining('github.com/roundtable-k8s'))
  })

  it('lists triggers with source type, target, active runs and state', async () => {
    mockApiGet.mockResolvedValue(three)
    render(<MemoryRouter><TriggersPage /></MemoryRouter>)
    const rows = (await screen.findAllByRole('row')).slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('schedule')
    expect(rows[0]).toHaveTextContent('nightly-scan')
    expect(rows[0]).toHaveTextContent('Ready')
    expect(rows[1]).toHaveTextContent('nats')
    expect(rows[1]).toHaveTextContent('Not ready')
    expect(rows[2]).toHaveTextContent('webhook')
    expect(rows[2]).toHaveTextContent('Suspended')
    expect(within(rows[0]).getByRole('link', { name: 'nightly' })).toHaveAttribute('href', '/triggers/roundtable/nightly')
  })

  it('shows an error banner when loading fails', async () => {
    mockApiGet.mockImplementation((url: string) => (url ? Promise.reject(new Error('boom')) : Promise.resolve([])))
    render(<MemoryRouter><TriggersPage /></MemoryRouter>)
    expect(await screen.findByText(/Failed to load triggers: boom/)).toBeInTheDocument()
  })
})

describe('TriggerDetailPage', () => {
  it('shows recent firings with skip reasons and run links', async () => {
    mockApiGet.mockResolvedValue(trig({
      name: 'nightly', activeRuns: ['run-2'],
      recentFirings: [
        { time: '2026-11-25T03:00:00Z', key: 'k1', run: 'run-2' },
        { time: '2026-11-24T03:00:00Z', key: 'k0', skipReason: 'ConcurrencyForbid' },
      ],
    }))
    render(
      <MemoryRouter initialEntries={['/triggers/roundtable/nightly']}>
        <Routes><Route path="/triggers/:namespace/:name" element={<TriggerDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    const section = await screen.findByRole('region', { name: 'recent firings' })
    expect(mockApiGet).toHaveBeenCalledWith('/api/triggers/roundtable/nightly', expect.anything())
    expect(section).toHaveTextContent('Skipped: ConcurrencyForbid')
    expect(within(section).getByRole('link', { name: 'run-2' })).toHaveAttribute('href', '/chains?chain=run-2')
  })
})

describe('TriggerDetailPage active runs', () => {
  it('links each active run to its chain run', async () => {
    mockApiGet.mockResolvedValue(three[0])
    render(
      <MemoryRouter initialEntries={['/triggers/roundtable/nightly']}>
        <Routes><Route path="/triggers/:namespace/:name" element={<TriggerDetailPage />} /></Routes>
      </MemoryRouter>,
    )
    const section = await screen.findByRole('region', { name: 'active runs' })
    expect(within(section).getByRole('link', { name: 'run-1' })).toHaveAttribute('href', '/chains?chain=run-1')
  })
})

describe('TriggersPage links', () => {
  it('links to the Schedules page', async () => {
    mockApiGet.mockResolvedValue([])
    render(<MemoryRouter><TriggersPage /></MemoryRouter>)
    expect(await screen.findByRole('link', { name: /Schedules/ })).toHaveAttribute('href', '/schedules')
  })
})
