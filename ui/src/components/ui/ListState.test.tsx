import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ListState } from '.'

const base = { what: 'missions', emptyTitle: 'No missions found.', emptySub: 'Create one.' }

describe('ListState', () => {
  it('shows a status spinner while loading with no data', () => {
    render(<ListState {...base} loading error={null} count={0}><p>rows</p></ListState>)
    expect(screen.getByRole('status')).toHaveTextContent('Loading missions…')
    expect(screen.queryByText('No missions found.')).toBeNull()
  })

  it('shows the error and never the empty state when the first fetch failed', () => {
    const onRetry = vi.fn()
    render(<ListState {...base} loading={false} error="boom" count={0} onRetry={onRetry}><p>rows</p></ListState>)
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load missions: boom')
    expect(screen.queryByText('No missions found.')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows the banner above the children when there is data', () => {
    render(<ListState {...base} loading={false} error="boom" count={2}><p>rows</p></ListState>)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByText('rows')).toBeInTheDocument()
  })

  it('shows the empty state when nothing loaded and nothing failed', () => {
    render(<ListState {...base} loading={false} error={null} count={0} emptyExtra={<a href="#x">docs</a>}><p>rows</p></ListState>)
    expect(screen.getByText('No missions found.')).toBeInTheDocument()
    expect(screen.getByText('Create one.')).toBeInTheDocument()
    expect(screen.getByText('docs')).toBeInTheDocument()
    expect(screen.queryByText('rows')).toBeNull()
  })

  it('renders children when there is data', () => {
    render(<ListState {...base} loading={false} error={null} count={1}><p>rows</p></ListState>)
    expect(screen.getByText('rows')).toBeInTheDocument()
  })
})
