import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { Button, LinkButton, ConfirmDialog } from './index'

describe('Button', () => {
  it('renders type=button with tone classes', () => {
    render(<Button tone="red">Go</Button>)
    const b = screen.getByRole('button', { name: 'Go' })
    expect(b).toHaveAttribute('type', 'button')
    expect(b.className).toContain('text-red-300')
    expect(b.className).toContain('disabled:opacity-50')
  })
  it.each([['gold', 'text-roundtable-gold'], ['gray', 'text-gray-300'], ['green', 'text-green-300'], ['amber', 'text-amber-300']] as const)('%s tone', (tone, cls) => {
    render(<Button tone={tone}>x</Button>)
    expect(screen.getByRole('button').className).toContain(cls)
  })
  it('LinkButton renders a link', () => {
    render(<MemoryRouter><LinkButton to="/a" tone="gold">Open</LinkButton></MemoryRouter>)
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/a')
  })
})

describe('ConfirmDialog', () => {
  const base = { title: 'Sure?', confirmLabel: 'Do it', onCancel: vi.fn(), onConfirm: vi.fn() }
  it('calls confirm and cancel', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn()
    render(<ConfirmDialog {...base} working={false} onConfirm={onConfirm} onCancel={onCancel} testId="d">body</ConfirmDialog>)
    expect(screen.getByTestId('d')).toHaveTextContent('body')
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
  it('disables both buttons while working', () => {
    render(<ConfirmDialog {...base} working>body</ConfirmDialog>)
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled()
  })
  it('shows the error with role=alert', () => {
    render(<ConfirmDialog {...base} working={false} error="boom">body</ConfirmDialog>)
    expect(screen.getByRole('alert')).toHaveTextContent('boom')
  })
})
