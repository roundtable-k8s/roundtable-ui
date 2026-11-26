import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { FleetPage } from './Fleet'
import type { Knight } from '../hooks/useFleet'
import { cardKey, type CardMap } from '../lib/cards'
import { galahadCard, patsyCard } from '../test/fixtures/cards'
import { isolated, notEnforced, optedOut } from '../test/fixtures/isolation'

const k = (name: string, domain: string): Knight => ({
  name, domain, status: 'online', ready: true, restarts: 0, age: '1h', image: 'knight:latest', skills: 1, nixTools: 1, labels: {},
})

let knights: Knight[] = []
vi.mock('../hooks/useFleet', () => ({
  useFleet: () => ({ knights, loading: false, error: null, refresh: vi.fn() }),
}))
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events: [] }) }))
let cards: CardMap = new Map()
vi.mock('../hooks/useCards', () => ({ useCards: () => ({ cards, loading: false, unavailable: false }) }))
vi.mock('../components/KnightDetailDrawer', () => ({
  KnightDetailDrawer: ({ knight }: { knight: Knight | null }) =>
    knight ? <div data-testid="drawer">{`${knight.name}:${knight.restarts}`}</div> : null,
}))

const names = () => screen.queryAllByRole('heading', { level: 3 }).map((h) => h.textContent)

beforeEach(() => {
  knights = [k('galahad', 'security'), k('patsy', 'vault'), k('kay', 'research')]
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
