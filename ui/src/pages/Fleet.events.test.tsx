import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FleetPage } from './Fleet'

const events = [
  { type: 'result', subject: 'a.results.t1', timestamp: '2026-11-24T10:00:00Z', table: 'a', data: { knight: 'galahad', cost: 1, success: true } },
  { type: 'result', subject: 'b.results.t2', timestamp: '2026-11-24T10:01:00Z', table: 'b', data: { knight: 'kay', cost: 4, success: true } },
]
vi.mock('../lib/api', () => ({ apiGet: vi.fn(() => Promise.resolve([])) }))
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events }) }))
vi.mock('../hooks/useCards', () => ({ useCards: () => ({ cards: new Map(), loading: false, unavailable: false }) }))
vi.mock('../components/KnightDetailDrawer', () => ({ KnightDetailDrawer: () => null }))

describe('Fleet event figures follow the table', () => {
  it('counts only the selected table cost', async () => {
    render(<MemoryRouter initialEntries={['/fleet?table=a']}><FleetPage /></MemoryRouter>)
    expect(await screen.findByText('$1.00')).toBeInTheDocument()
    expect(screen.queryByText('$5.00')).toBeNull()
    expect(screen.queryByText('$4.00')).toBeNull()
  })
  it('sums all tables with none selected', async () => {
    render(<MemoryRouter initialEntries={['/fleet']}><FleetPage /></MemoryRouter>)
    expect(await screen.findByText('$5.00')).toBeInTheDocument()
  })
})
