import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RoundTablesPage } from './RoundTables'
import type { RoundTable } from '../lib/types'

const base = { namespace: 'ns', phase: 'Ready', knightsReady: 3, knightsTotal: 5, natsPrefix: 'p', costBudgetUSD: '', totalCost: '0' }
const tables: RoundTable[] = [
  { ...base, name: 'roundtable-dev', plannerKnight: 'dev-planner', plannerEnabled: true, knightsScaledToZero: 2, knightsSuspended: 0, knightsNotReady: 0, policies: { costBudgetUSD: '', maxConcurrentPlanTasks: 6, maxMissions: 3 } },
  { ...base, name: 'personal', plannerEnabled: false, knightsSuspended: 1, policies: { costBudgetUSD: '', maxConcurrentPlanTasks: 0, maxMissions: 0 } },
]

let fetchState: { data: RoundTable[]; error: string | null } = { data: tables, error: null }
vi.mock('../hooks/usePolledFetch', () => ({
  usePolledFetch: () => ({ ...fetchState, loading: false, refresh: vi.fn() }),
}))

const renderPage = (url = '/roundtables') =>
  render(<MemoryRouter initialEntries={[url]}><RoundTablesPage /></MemoryRouter>)

describe('RoundTablesPage planner and breakdown', () => {
  it('shows planner link and asleep count', () => {
    renderPage()
    expect(screen.getByRole('link', { name: 'dev-planner' })).toBeTruthy()
    expect(screen.getByTestId('breakdown-roundtable-dev').textContent).toBe('3 ready, 2 asleep, 0 suspended, 0 not ready')
  })
  it('shows "Planner: none" when disabled and defaults missing counts', () => {
    renderPage()
    expect(screen.getByText('Planner: none')).toBeTruthy()
    expect(screen.getByTestId('breakdown-personal').textContent).toBe('3 ready, 0 asleep, 1 suspended, 0 not ready')
  })
  it('respects the table selector', () => {
    renderPage('/roundtables?table=personal')
    expect(screen.queryByText('roundtable-dev')).toBeNull()
    expect(screen.getByText('personal')).toBeTruthy()
  })
  it('shows Max Concurrent Plan Tasks, unlimited for 0, and no removed policies', () => {
    renderPage()
    screen.getAllByText('More details').forEach(b => fireEvent.click(b))
    const rows = screen.getAllByText('Max Concurrent Plan Tasks').map(e => e.parentElement?.textContent)
    expect(rows).toContain('Max Concurrent Plan Tasks6')
    expect(rows).toContain('Max Concurrent Plan Tasksunlimited')
    expect(screen.queryByText('Max Knights')).toBeNull()
    expect(screen.queryByText('Max Concurrent Tasks')).toBeNull()
  })
})

describe('RoundTablesPage load failure', () => {
  it('shows the error and no empty state', () => {
    fetchState = { data: [], error: 'boom' }
    renderPage()
    expect(screen.getByText(/Failed to load round tables: boom/)).toBeTruthy()
    expect(screen.queryByText('No round tables found.')).toBeNull()
    fetchState = { data: tables, error: null }
  })
})
