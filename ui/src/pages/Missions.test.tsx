import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { MissionsPage } from './Missions'
import type { Mission } from '../hooks/useMissions'

let state: { missions: Mission[]; loading: boolean; error: string | null }
const refresh = vi.fn()
vi.mock('../hooks/useMissions', () => ({ useMissions: () => ({ ...state, refresh }) }))
vi.mock('../components/MissionCard', () => ({
  MissionCard: ({ mission }: { mission: Mission }) => <div data-testid="mission-card">{mission.name}</div>,
}))
vi.mock('./MissionWizard', () => ({
  MissionWizard: ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) => (
    <div data-testid="wizard"><button onClick={onClose}>close</button><button onClick={onCreated}>created</button></div>
  ),
}))

function mission(name: string, phase: string, totalCost = '0'): Mission {
  return {
    name, namespace: 'ns', phase, objective: 'o', startedAt: null, expiresAt: null,
    knights: null, chains: null, costBudgetUSD: '10', totalCost, ttlSeconds: 3600, timeoutSeconds: 600, roundTableRef: 'rt',
  }
}

const renderPage = () => render(<MemoryRouter><MissionsPage /></MemoryRouter>)

beforeEach(() => {
  refresh.mockReset()
  state = { missions: [], loading: false, error: null }
})

describe('MissionsPage', () => {
  it('shows a spinner message while loading', () => {
    state = { missions: [], loading: true, error: null }
    renderPage()
    expect(screen.getByText('Loading missions...')).toBeInTheDocument()
    expect(screen.queryByText('No missions found.')).toBeNull()
  })

  it('shows the empty state', () => {
    renderPage()
    expect(screen.getByText('No missions found.')).toBeInTheDocument()
  })

  it('shows the error', () => {
    state = { missions: [], loading: false, error: 'boom' }
    renderPage()
    expect(screen.getByText(/Failed to load missions: boom/)).toBeInTheDocument()
  })

  it('lists missions and totals the stats', () => {
    state = {
      loading: false, error: null,
      missions: [mission('a', 'Active', '1.50'), mission('b', 'Succeeded', '2.00'), mission('c', 'Failed')],
    }
    renderPage()
    expect(screen.getAllByTestId('mission-card').map((c) => c.textContent)).toEqual(['a', 'b', 'c'])
    expect(screen.getByText('Total Missions').closest('div.rounded-xl')).toHaveTextContent('3')
    expect(screen.getByText('$3.50')).toBeInTheDocument()
  })

  it('filters by phase and clears the filter', async () => {
    state = { loading: false, error: null, missions: [mission('a', 'Active'), mission('b', 'Failed')] }
    renderPage()
    const filters = screen.getByText('Phase:').nextElementSibling as HTMLElement
    await userEvent.click(within(filters).getByText('Failed'))
    expect(screen.getAllByTestId('mission-card').map((c) => c.textContent)).toEqual(['b'])

    await userEvent.click(within(filters).getByText('Expired'))
    expect(screen.getByText('No missions match your filters.')).toBeInTheDocument()

    await userEvent.click(screen.getByText('Clear filters'))
    expect(screen.getAllByTestId('mission-card')).toHaveLength(2)
  })

  it('refreshes from the button and after the wizard creates a mission', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: /New Mission/ }))
    expect(screen.getByTestId('wizard')).toBeInTheDocument()
    await userEvent.click(screen.getByText('created'))
    expect(screen.queryByTestId('wizard')).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
