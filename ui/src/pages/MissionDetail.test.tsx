import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { MissionDetailPage } from './MissionDetail'
import { ApiError } from '../lib/api'
import type { Mission } from '../hooks/useMissions'

const mockApiGet = vi.fn()
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiGet: (...a: unknown[]) => mockApiGet(...a),
}))

function mission(over: Partial<Mission> = {}): Mission {
  return {
    table: 'fleet-a', name: 'm1', namespace: 'roundtable', phase: 'Active', objective: 'Ship the thing',
    startedAt: '2026-11-25T06:00:00Z', expiresAt: null, knights: ['galahad'], chains: ['c1'],
    costBudgetUSD: '5', totalCost: '1.5', ttlSeconds: 3600, timeoutSeconds: 600, roundTableRef: 'rt',
    knightStatuses: [{ name: 'galahad', ready: true, tasksCompleted: 2, ephemeral: false }],
    chainStatuses: [{ name: 'build', chainCRName: 'm1-build', phase: 'Running', costUSD: '1.5' }],
    ...over,
  }
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/missions/m1']}>
      <Routes>
        <Route path="/missions/:name" element={<MissionDetailPage />} />
        <Route path="/missions" element={<div>missions list</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { mockApiGet.mockReset() })

describe('MissionDetailPage', () => {
  it('renders status, objective, knights, chains and cost', async () => {
    mockApiGet.mockResolvedValue(mission())
    renderPage()
    expect(await screen.findByRole('heading', { level: 1, name: /m1/ })).toBeInTheDocument()
    expect(screen.getByText('Ship the thing')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
    expect(mockApiGet).toHaveBeenCalledWith('/api/missions/m1', expect.anything())
    expect(within(screen.getByRole('region', { name: 'knights' })).getByText('galahad')).toBeInTheDocument()
    const chain = within(screen.getByRole('region', { name: 'chains' })).getByRole('link', { name: 'build' })
    expect(chain).toHaveAttribute('href', '/chains?chain=m1-build')
    expect(screen.getByRole('region', { name: 'cost' })).toHaveTextContent('/')
    expect(screen.queryByRole('region', { name: 'why' })).not.toBeInTheDocument()
  })

  it('shows "Mission not found" with a link back on 404, without an error banner', async () => {
    mockApiGet.mockRejectedValue(new ApiError(404, 'mission not found'))
    renderPage()
    expect(await screen.findByText('Mission not found')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to missions' })).toHaveAttribute('href', '/missions')
    expect(screen.queryByText(/Failed to load mission/)).not.toBeInTheDocument()
  })

  it('shows an error banner on other errors', async () => {
    mockApiGet.mockRejectedValue(new ApiError(500, 'boom'))
    renderPage()
    expect(await screen.findByText(/Failed to load mission: boom/)).toBeInTheDocument()
    expect(screen.queryByText('Mission not found')).not.toBeInTheDocument()
  })

  it('handles null knights and chains', async () => {
    mockApiGet.mockResolvedValue(mission({ knights: null, chains: null, knightStatuses: undefined, chainStatuses: undefined }))
    renderPage()
    expect(await screen.findByText('No knights assigned yet.')).toBeInTheDocument()
    expect(screen.getByText('No chains yet.')).toBeInTheDocument()
  })

  it('lists only conditions that are not True under Why', async () => {
    mockApiGet.mockResolvedValue(mission({
      conditions: [
        { type: 'Ready', status: 'True', reason: 'AllGood' },
        { type: 'BudgetOK', status: 'False', reason: 'OverBudget', message: 'spent more than allowed' },
      ],
    }))
    renderPage()
    const why = await screen.findByRole('region', { name: 'why' })
    expect(why).toHaveTextContent('BudgetOK')
    expect(why).toHaveTextContent('OverBudget')
    expect(why).toHaveTextContent('spent more than allowed')
    expect(why).not.toHaveTextContent('AllGood')
  })
})
