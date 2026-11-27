import { describe, it, expect, vi, afterEach } from 'vitest'
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

afterEach(() => { fetchState = { data: tables, error: null } })

const renderPage = (url = '/roundtables') =>
  render(<MemoryRouter initialEntries={[url]}><RoundTablesPage /></MemoryRouter>)

describe('RoundTablesPage planner and breakdown', () => {
  it('shows planner link and asleep count', () => {
    renderPage()
    expect(screen.getByRole('link', { name: 'dev-planner' })).toBeTruthy()
    expect(screen.getByTestId('breakdown-roundtable-dev').textContent).toBe('3 ready, 2 asleep, 0 suspended, 0 not ready')
  })
  it('links the planner to its drawer on the fleet page', () => {
    renderPage()
    expect(screen.getByRole('link', { name: 'dev-planner' }).getAttribute('href')).toBe('/fleet?table=roundtable-dev&knight=dev-planner')
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
  })
})

describe('RoundTablesPage budgets and toggle', () => {
  const capped: RoundTable = { ...base, name: 'capped', costBudgetUSD: '50', totalCost: '12.4', policies: { costBudgetUSD: '50', maxConcurrentPlanTasks: 0, maxMissions: 0 } }
  const unlimited: RoundTable = { ...base, name: 'open', costBudgetUSD: '0', totalCost: '12.4', policies: { costBudgetUSD: '', maxConcurrentPlanTasks: 0, maxMissions: 0 } }

  it('shows the budget on the card only when there is one', () => {
    fetchState = { data: [capped, unlimited], error: null }
    renderPage()
    expect(screen.getByText(/\/ \$50\.00/)).toBeTruthy()
    expect(screen.getAllByText(/\$12\.40/).length).toBe(2)
    expect(screen.queryByText(/\/ \$0/)).toBeNull()
  })

  it('reads unlimited budgets and max missions in the policies block', () => {
    fetchState = { data: [unlimited], error: null }
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /more details/i }))
    const budgetRow = screen.getByText('Cost Budget').parentElement
    expect(budgetRow?.textContent).toBe('Cost Budgetunlimited')
    expect(screen.getByText('Max Missions').parentElement?.textContent).toBe('Max Missionsunlimited')
  })

  it('never shows a bare dollar sign for an empty budget', () => {
    fetchState = { data: [unlimited], error: null }
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /more details/i }))
    expect(screen.queryByText('$')).toBeNull()
  })

  it('exposes aria-expanded and aria-controls on the toggle', () => {
    fetchState = { data: [capped], error: null }
    renderPage()
    const btn = screen.getByRole('button', { name: /more details/i })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    const id = btn.getAttribute('aria-controls')
    expect(id).toBeTruthy()
    fireEvent.click(btn)
    expect(screen.getByRole('button', { name: /less/i })).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById(id!)).toBeTruthy()
  })
})
