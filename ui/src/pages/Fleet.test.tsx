import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { FleetPage } from './Fleet'
import type { Knight } from '../hooks/useFleet'
import { cardKey, type CardMap } from '../lib/cards'
import { galahadCard, patsyCard } from '../test/fixtures/cards'
import { isolated, notEnforced, optedOut } from '../test/fixtures/isolation'

const k = (name: string, domain: string): Knight => ({
  name, domain, status: 'online', ready: true, restarts: 0, age: '1h', image: 'knight:latest', skills: 1, nixTools: 1, labels: {},
})

let knights: Knight[] = []
let fleetError: string | null = null
let fleetLoading = false
vi.mock('../hooks/useFleet', () => ({
  useFleet: () => ({ knights, loading: fleetLoading, error: fleetError, refresh: vi.fn() }),
}))
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events: [] }) }))
let cards: CardMap = new Map()
vi.mock('../hooks/useCards', () => ({ useCards: () => ({ cards, loading: false, unavailable: false }) }))
vi.mock('../components/KnightDetailDrawer', () => ({
  KnightDetailDrawer: ({ knight, onClose }: { knight: Knight | null; onClose: () => void }) =>
    knight ? <div data-testid="drawer">{`${knight.name}:${knight.restarts}`}<button onClick={onClose}>close</button></div> : null,
}))

const Where = () => <div data-testid="where">{useLocation().search}</div>
const names = () => screen.queryAllByRole('heading', { level: 3 }).map((h) => h.textContent)

beforeEach(() => {
  knights = [k('galahad', 'security'), k('patsy', 'vault'), k('kay', 'research')]
  fleetError = null
  fleetLoading = false
  cards = new Map([
    [cardKey('personal', 'galahad'), galahadCard],
    [cardKey('personal', 'patsy'), patsyCard],
  ])
})

describe('Fleet skill filter', () => {
  it('filters knights by skill tag', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(names()).toEqual(['galahad', 'kay', 'patsy'])
    await user.click(screen.getByRole('button', { name: 'security' }))
    expect(names()).toEqual(['galahad'])
    expect(screen.getByText('1 of 3 knights')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'security' }))
    expect(names()).toEqual(['galahad', 'kay', 'patsy'])
  })

  it('filters knights by free text and clears', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    await user.type(screen.getByLabelText('Filter by skill'), 'vault')
    expect(names()).toEqual(['patsy'])
    await user.clear(screen.getByLabelText('Filter by skill'))
    await user.type(screen.getByLabelText('Filter by skill'), 'nothing-matches')
    expect(names()).toEqual([])
    expect(screen.getByText('No knight has a skill matching this filter.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /clear/i }))
    expect(names()).toEqual(['galahad', 'kay', 'patsy'])
  })

  it('hides the filter and shows every knight when there are no cards', () => {
    cards = new Map()
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.queryByLabelText('Filter by skill')).not.toBeInTheDocument()
    expect(names()).toEqual(['galahad', 'kay', 'patsy'])
  })
})

describe('Fleet isolation filter (#269)', () => {
  it('shows only opted-out and not-enforced knights', async () => {
    cards = new Map()
    knights = [
      { ...k('galahad', 'security'), isolation: isolated },
      { ...k('kay', 'research'), isolation: optedOut },
      { ...k('patsy', 'vault'), isolation: notEnforced },
      { ...k('tristan', 'infra'), isolation: { state: 'unknown', hostnameRulesEnforced: false } },
      k('bedivere', 'home'),
    ]
    const user = userEvent.setup()
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(names()).toEqual(['bedivere', 'galahad', 'kay', 'patsy', 'tristan'])
    const filter = screen.getByRole('button', { name: /not isolated \(2\)/i })
    await user.click(filter)
    expect(filter).toHaveAttribute('aria-pressed', 'true')
    expect(names()).toEqual(['kay', 'patsy'])
    await user.click(filter)
    expect(names()).toEqual(['bedivere', 'galahad', 'kay', 'patsy', 'tristan'])
  })

  it('hides the filter when the API reports no isolation', () => {
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.queryByRole('button', { name: /not isolated/i })).not.toBeInTheDocument()
  })
})

describe('Fleet card of the knight\'s own table', () => {
  it('uses the card of the knight\'s table when the name exists in two tables', async () => {
    const user = userEvent.setup()
    const opsCard = {
      ...galahadCard,
      table: 'work',
      card: { ...galahadCard.card, skills: [{ id: 'deploy', name: 'deploy', tags: ['ops'] }] },
    }
    knights = [{ ...k('galahad', 'security'), table: 'work' }]
    cards = new Map([
      [cardKey('personal', 'galahad'), galahadCard], // first in the map, other table
      [cardKey('work', 'galahad'), opsCard],
    ])
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    await user.click(screen.getByRole('button', { name: 'ops' }))
    expect(names()).toEqual(['galahad'])
  })
})

describe('Fleet detail drawer follows the live fleet', () => {
  it('shows the restart count from the next poll', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<MemoryRouter><FleetPage /></MemoryRouter>)
    await user.click(screen.getByRole('heading', { level: 3, name: 'galahad' }))
    expect(screen.getByTestId('drawer')).toHaveTextContent('galahad:0')
    knights = knights.map((x) => (x.name === 'galahad' ? { ...x, restarts: 7 } : x))
    rerender(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.getByTestId('drawer')).toHaveTextContent('galahad:7')
  })

  it('closes when the next poll no longer includes the knight', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<MemoryRouter><FleetPage /></MemoryRouter>)
    await user.click(screen.getByRole('heading', { level: 3, name: 'galahad' }))
    expect(screen.getByTestId('drawer')).toBeInTheDocument()
    knights = knights.filter((x) => x.name !== 'galahad')
    rerender(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.queryByTestId('drawer')).not.toBeInTheDocument()
  })
})

describe('Fleet name/status filter, paging and focus (#401)', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => k(`knight-${String(i).padStart(3, '0')}`, 'x'))

  it('filters by name, case-insensitively', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    await user.type(screen.getByLabelText('Filter by name'), 'PAT')
    expect(names()).toEqual(['patsy'])
    expect(screen.getByTestId('fleet-count').textContent).toBe('1/3')
  })

  it('filters by status and sorts by status', async () => {
    const user = userEvent.setup()
    knights = [{ ...k('a', 'x'), status: 'offline' }, k('b', 'x'), { ...k('c', 'x'), status: 'scaled-to-zero' }]
    render(<MemoryRouter initialEntries={['/fleet?sort=status']}><FleetPage /></MemoryRouter>)
    expect(names()).toEqual(['b', 'c', 'a'])
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'scaled-to-zero')
    expect(names()).toEqual(['c'])
    expect(screen.getByTestId('fleet-count').textContent).toBe('1/3')
  })

  it('renders 60 cards and shows more on demand; a filter resets the page', () => {
    knights = many(150)
    const { container } = render(<MemoryRouter><FleetPage /></MemoryRouter>)
    const count = () => container.querySelectorAll('h3').length
    expect(count()).toBe(60)
    fireEvent.click(screen.getByText('Show 60 more (90 left)'))
    expect(count()).toBe(120)
    fireEvent.click(screen.getByText('Show 60 more (30 left)'))
    expect(count()).toBe(150)
    expect(screen.queryByText(/Show 60 more/)).toBeNull()
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'knight-0' } })
    expect(count()).toBe(60)
    expect(screen.getByTestId('fleet-count').textContent).toBe('100/150')
  })

  it('?knight= opens the drawer once; closing removes the parameter', () => {
    render(<MemoryRouter initialEntries={['/fleet?knight=kay']}><FleetPage /><Where /></MemoryRouter>)
    expect(screen.getByTestId('drawer').textContent).toContain('kay')
    fireEvent.click(screen.getByText('close'))
    expect(screen.queryByTestId('drawer')).toBeNull()
    expect(screen.getByTestId('where').textContent).not.toContain('knight=')
  })

  it('shows nothing special for an unknown ?knight=', () => {
    render(<MemoryRouter initialEntries={['/fleet?knight=nobody']}><FleetPage /></MemoryRouter>)
    expect(screen.queryByTestId('drawer')).toBeNull()
    expect(names()).toHaveLength(3)
  })
})

describe('Fleet error banner', () => {
  it('suggests checking the API and its logs, not running it from source', () => {
    fleetError = 'Failed to fetch'
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.getByText('⚠️ Failed to fetch')).toBeInTheDocument()
    expect(screen.getByText('Check that the dashboard API is reachable and look at its pod logs.')).toBeInTheDocument()
  })
})

describe('Fleet first run', () => {
  it('shows the first-run panel on an empty successful fleet', () => {
    knights = []
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'No knights yet' })).toBeInTheDocument()
  })

  it('hides the first-run panel when the fleet has a knight', () => {
    knights = [k('galahad', 'security')]
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.queryByRole('heading', { name: 'No knights yet' })).not.toBeInTheDocument()
  })

  it('hides the first-run panel while loading', () => {
    knights = []
    fleetLoading = true
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.queryByRole('heading', { name: 'No knights yet' })).not.toBeInTheDocument()
  })

  it('hides the first-run panel on a failed request and shows the error', () => {
    knights = []
    fleetError = 'Failed to fetch'
    render(<MemoryRouter><FleetPage /></MemoryRouter>)
    expect(screen.queryByRole('heading', { name: 'No knights yet' })).not.toBeInTheDocument()
    expect(screen.getByText('⚠️ Failed to fetch')).toBeInTheDocument()
  })
})
