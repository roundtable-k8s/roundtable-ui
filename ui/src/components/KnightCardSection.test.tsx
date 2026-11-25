import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { KnightCardSection, KnightDetailDrawer } from './KnightDetailDrawer'
import { galahadCard, patsyCard } from '../test/fixtures/cards'
import type { Knight } from '../hooks/useFleet'

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiGet: vi.fn(() => new Promise(() => {})),
}))
vi.mock('../hooks/useKnightSession', () => ({
  useKnightSession: () => ({ stats: null, recent: [], loading: false, error: null, fetchStats: vi.fn(), fetchRecent: vi.fn() }),
}))

const knight: Knight = {
  name: 'galahad', domain: 'security', status: 'online', ready: true, restarts: 0, age: '1h',
  image: 'knight:latest', skills: 2, nixTools: 2, labels: {},
}

describe('KnightCardSection', () => {
  it('renders skills, model, tools, task subject and load', () => {
    render(<KnightCardSection entry={galahadCard} />)
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.getByText('1 / 3 active')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-4-20250514')).toBeInTheDocument()
    expect(screen.getByText('fleet-a.tasks.security.galahad')).toBeInTheDocument()
    expect(screen.getByText('nmap')).toBeInTheDocument()
    expect(screen.getByText('whois')).toBeInTheDocument()
    expect(screen.getByText('Skills (2)')).toBeInTheDocument()
    expect(screen.getByText('cve-triage')).toBeInTheDocument()
    expect(screen.getByText('Triage a CVE against the fleet images.')).toBeInTheDocument()
    expect(screen.getByText('design')).toBeInTheDocument()
  })

  it('shows a suspended knight without load', () => {
    render(<KnightCardSection entry={patsyCard} />)
    expect(screen.getByText('Suspended')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('falls back to the knight concurrency for max', () => {
    render(<KnightCardSection entry={{ ...galahadCard, stats: { activeTasks: 0 } }} fallbackMax={4} />)
    expect(screen.getByText('0 / 4 active')).toBeInTheDocument()
  })
})

describe('KnightDetailDrawer card section', () => {
  it('shows the Card section when a card is given', () => {
    render(<KnightDetailDrawer knight={knight} onClose={() => {}} card={galahadCard} />)
    const section = screen.getByTestId('knight-card-section')
    expect(within(section).getByText('Card')).toBeInTheDocument()
  })

  it('omits the Card section for a knight without a card', () => {
    render(<KnightDetailDrawer knight={knight} onClose={() => {}} />)
    expect(screen.queryByTestId('knight-card-section')).not.toBeInTheDocument()
  })
})
