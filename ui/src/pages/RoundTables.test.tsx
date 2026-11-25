import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RoundTablesPage } from './RoundTables'
import type { RoundTable } from '../lib/types'

const base = { namespace: 'ns', phase: 'Ready', knightsReady: 3, knightsTotal: 5, natsPrefix: 'p', costBudgetUSD: '', totalCost: '0' }
const tables: RoundTable[] = [
  { ...base, name: 'roundtable-dev', plannerKnight: 'dev-planner', plannerEnabled: true, knightsScaledToZero: 2, knightsSuspended: 0, knightsNotReady: 0 },
  { ...base, name: 'personal', plannerEnabled: false, knightsSuspended: 1 },
]

vi.mock('../hooks/usePolledFetch', () => ({
  usePolledFetch: () => ({ data: tables, loading: false, error: null, refresh: vi.fn() }),
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
})
