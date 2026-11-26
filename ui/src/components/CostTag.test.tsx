import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CostTag } from './CostTag'

describe('CostTag', () => {
  it('shows the cost without a marker or hint', () => {
    const { container } = render(<CostTag costUSD="1.2" />)
    expect(screen.getByText('$1.20')).toBeInTheDocument()
    expect(screen.queryByText('notional')).toBeNull()
    expect(container.firstChild).not.toHaveAttribute('title')
  })
  it('shows a dash and no hint without cost data', () => {
    const { container } = render(<CostTag costUSD={null} notional />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('notional')).toBeNull()
    expect(container.firstChild).not.toHaveAttribute('title')
  })
  it('marks a notional step', () => {
    render(<CostTag costUSD="0.75" notional />)
    expect(screen.getByText('$0.75')).toHaveClass('italic')
    expect(screen.getByText('notional')).toBeInTheDocument()
  })
  it('marks a partly notional total', () => {
    render(<CostTag costUSD="1.2" notionalUSD="0.25" />)
    expect(screen.getByText('(incl. $0.25 notional)')).toBeInTheDocument()
    expect(screen.getByText('$1.20').parentElement).toHaveAttribute('title')
  })
  it('marks a fully notional total', () => {
    render(<CostTag costUSD="0.75" notionalUSD="0.75" />)
    expect(screen.getByText('notional')).toBeInTheDocument()
  })
  it('applies className', () => {
    const { container } = render(<CostTag costUSD="1" className="justify-end" />)
    expect(container.firstChild).toHaveClass('justify-end')
  })
})
