import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { LivePage } from './Live'
import type { NatsEvent } from '../hooks/useWebSocket'

const ev = (n: number, data: unknown = { task: `task ${n}` }): NatsEvent => ({
  type: 'task', subject: `fleet.tasks.security.t${n}`, timestamp: `2026-11-24T10:0${n}:00Z`, data,
})
const ws = { events: [] as NatsEvent[], connected: true, error: null as string | null, historyError: null as string | null }

vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ws }))
vi.mock('../hooks/useFleet', () => ({ useFleet: () => ({ knights: [], error: null }) }))
vi.mock('../components/FleetGraph', () => ({ FleetGraph: () => <div data-testid="graph" /> }))
vi.mock('../components/KnightDetailDrawer', () => ({ KnightDetailDrawer: () => null }))
vi.mock('../components/TaskActivityPanel', () => ({ TaskActivityPanel: () => null }))

const ui = () => <MemoryRouter><LivePage /></MemoryRouter>

beforeEach(() => {
  ws.events = []; ws.connected = true; ws.error = null; ws.historyError = null
})

describe('LivePage feed', () => {
  it('keeps the opened message open when new events are prepended', async () => {
    ws.events = [ev(3), ev(2), ev(1)]
    const { rerender } = render(ui())
    await userEvent.click(screen.getByText('task 2'))
    expect(screen.getAllByText(/"task": "task 2"/)).toHaveLength(1)
    ws.events = [ev(6), ev(5), ev(4), ...ws.events]
    rerender(ui())
    const open = screen.getAllByText(/"task": "task/)
    expect(open).toHaveLength(1)
    expect(open[0].textContent).toContain('task 2')
  })

  it('renders a structured result without crashing', () => {
    ws.events = [{ type: 'result', subject: 'fleet.results.t1', timestamp: '2026-11-24T10:00:00Z', data: { knight: 'Galahad', success: true, result: { a: 1 } } }]
    render(ui())
    expect(screen.getByText('{"a":1}')).toBeInTheDocument()
  })

  it('survives payloads that parse to null or a number', () => {
    ws.events = [ev(1, 'null'), ev(2, '12'), ev(3, null)]
    render(ui())
    expect(screen.getByText('(3 events)')).toBeInTheDocument()
  })

  it('says why the feed is disconnected', () => {
    ws.connected = false
    ws.error = 'live feed unreachable'
    render(ui())
    expect(screen.getByText('Disconnected')).toBeInTheDocument()
    expect(screen.getByText(/live feed unreachable/)).toBeInTheDocument()
  })

  it('tells a failed history load from an idle feed', () => {
    render(ui())
    expect(screen.getByText('Waiting for messages…')).toBeInTheDocument()
    ws.historyError = 'HTTP 500'
    render(ui())
    expect(screen.getByText(/Could not load message history: HTTP 500/)).toBeInTheDocument()
  })
})
