import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RefreshButton } from '.'

describe('RefreshButton', () => {
  it('renders without a time when updatedAt is missing', () => {
    render(<RefreshButton onClick={() => {}} />)
    expect(screen.queryByText(/Updated/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })
  it('shows the update time with a full-date title and calls onClick', () => {
    const onClick = vi.fn()
    const at = new Date(2026, 0, 2, 14, 3, 21).getTime()
    render(<RefreshButton onClick={onClick} updatedAt={at} />)
    const el = screen.getByText(/^Updated /)
    expect(el.textContent).toBe(`Updated ${new Date(at).toLocaleTimeString()}`)
    expect(el.getAttribute('aria-live')).toBe('off')
    expect(el.getAttribute('title')).toBe(new Date(at).toLocaleString())
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
