import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { MissionsPage } from './Missions'
import type { Mission } from '../hooks/useMissions'

let state: { missions: Mission[]; loading: boolean; error: string | null }
const refresh = vi.fn()
vi.mock('../hooks/useMissions', () => ({ useMissions: () => ({ ...state, refresh }) }))
vi.mock('../components/MissionCard', () => ({
  MissionCard: ({ mission, href, onClick, onDeleted }: { mission: Mission; href?: string; onClick?: () => void; onDeleted?: () => void }) => (
    <div data-testid="mission-card" onClick={onClick}><a href={href}>{mission.name}</a><button aria-label="del" onClick={onDeleted} /></div>
  ),
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

const renderPage = () => render(
  <MemoryRouter initialEntries={['/missions']}>
    <Routes>
      <Route path="/missions" element={<MissionsPage />} />
      <Route path="/missions/:name" element={<div>detail page</div>} />
    </Routes>
  </MemoryRouter>,
)

beforeEach(() => {
  refresh.mockReset()
  state = { missions: [], loading: false, error: null }
})

describe('MissionsPage', () => {
  it('links each card to its detail page and navigates on click', async () => {
    state = { missions: [mission('a b', 'Active')], loading: false, error: null }
    renderPage()
    expect(screen.getByRole('link', { name: 'a b' })).toHaveAttribute('href', '/missions/a%20b')
    await userEvent.click(screen.getByTestId('mission-card'))
    expect(await screen.findByText('detail page')).toBeInTheDocument()
  })

  it('shows a spinner message while loading', () => {
    state = { missions: [], loading: true, error: null }
    renderPage()
    expect(screen.getByText('Loading missions…')).toBeInTheDocument()
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
    expect(screen.queryByText('No missions found.')).toBeNull()
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

  it('refreshes when the refresh button is clicked', async () => {
    renderPage()
    expect(refresh).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('closes the wizard and refreshes after it creates a mission', async () => {
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: /New Mission/ }))
    expect(screen.getByTestId('wizard')).toBeInTheDocument()
    await userEvent.click(screen.getByText('created'))
    expect(screen.queryByTestId('wizard')).toBeNull()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('refreshes the list after a card delete', async () => {
    state = { missions: [mission('a', 'Succeeded')], loading: false, error: null }
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'del' }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
