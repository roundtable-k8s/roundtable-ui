import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { FleetPage } from './Fleet'
import { apiGet } from '../lib/api'
import type { Knight } from '../hooks/useFleet'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events: [] }) }))
vi.mock('../hooks/useCards', () => ({ useCards: () => ({ cards: new Map(), loading: false, unavailable: false }) }))
vi.mock('../components/KnightDetailDrawer', () => ({
  KnightDetailDrawer: ({ knight }: { knight: Knight | null }) => (knight ? <div data-testid="drawer">{knight.name}</div> : null),
}))

const k = (name: string, table: string): Knight => ({
  table, name, domain: 'x', status: 'online', ready: true, restarts: 0, age: '1h', image: 'i', labels: {},
})
const all = [k('galahad', 'personal'), k('rt-ui', 'roundtable-dev')]
const mockApiGet = vi.mocked(apiGet)
const names = () => screen.queryAllByRole('heading', { level: 3 }).map((h) => h.textContent)

beforeEach(() => {
  mockApiGet.mockReset()
  // Like the API: ?table= narrows the list
  mockApiGet.mockImplementation((url: string) => {
    const t = new URL(url, 'http://x').searchParams.get('table')
    return Promise.resolve(all.filter((x) => !t || x.table === t))
  })
})

describe('Fleet table filter', () => {
  it('selecting personal hides roundtable-dev knights', async () => {
    render(<MemoryRouter initialEntries={['/fleet?table=personal']}><FleetPage /></MemoryRouter>)
    await waitFor(() => expect(names()).toEqual(['galahad']))
    expect(mockApiGet).toHaveBeenCalledWith('/api/fleet?table=personal', expect.anything())
    expect(screen.queryByTestId('table-badge')).toBeNull()
  })

  it('lists every table with a badge on each card when none is selected', async () => {
    render(<MemoryRouter initialEntries={['/fleet']}><FleetPage /></MemoryRouter>)
    await waitFor(() => expect(names()).toEqual(['galahad', 'rt-ui']))
    expect(screen.getAllByTestId('table-badge').map((b) => b.textContent)).toEqual(['personal', 'roundtable-dev'])
  })

  it('?table=&knight= opens the drawer when the table matches', async () => {
    render(<MemoryRouter initialEntries={['/fleet?table=personal&knight=galahad']}><FleetPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('drawer').textContent).toBe('galahad'))
  })

  it('does not open a knight that belongs to another table', async () => {
    render(<MemoryRouter initialEntries={['/fleet?table=personal&knight=rt-ui']}><FleetPage /></MemoryRouter>)
    await waitFor(() => expect(names()).toEqual(['galahad']))
    expect(screen.queryByTestId('drawer')).toBeNull()
  })
})
