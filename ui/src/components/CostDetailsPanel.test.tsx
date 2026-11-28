import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { CostDetailsPanel, type CostDetailsPanelProps } from './CostDetailsPanel'

const props = (over: Partial<CostDetailsPanelProps> = {}): CostDetailsPanelProps => ({
  entries: [{ knight: 'galahad', cost: 2, timestamp: '2026-11-20T12:00:00', taskId: 't1', success: true }],
  chainRows: [], timeRange: 'week', onTimeRange: vi.fn(), expanded: true, onToggle: vi.fn(),
  onDownloadCsv: vi.fn(), eventsCoverage: 'last 1 events', ...over,
})
const r = (p: CostDetailsPanelProps) => render(<MemoryRouter><CostDetailsPanel {...p} /></MemoryRouter>)

describe('CostDetailsPanel', () => {
  it('shows tables and coverage when expanded', () => {
    r(props())
    expect(screen.getByRole('table', { name: 'Most expensive tasks' })).toBeInTheDocument()
    expect(screen.getByTestId('cost-coverage')).toHaveTextContent('last 1 events')
    expect(screen.getByText('No chain runs in this range')).toBeInTheDocument()
  })
  it('hides the body when collapsed and toggles on click', () => {
    const p = props({ expanded: false })
    r(p)
    expect(screen.queryByTestId('cost-coverage')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Cost Details/ }))
    expect(p.onToggle).toHaveBeenCalled()
  })
  it('fires range and csv callbacks', () => {
    const p = props()
    r(p)
    fireEvent.click(screen.getByText('Last 24h'))
    expect(p.onTimeRange).toHaveBeenCalledWith('day')
    fireEvent.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect(p.onDownloadCsv).toHaveBeenCalled()
  })
})
