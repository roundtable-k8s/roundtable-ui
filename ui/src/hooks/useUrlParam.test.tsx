import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useUrlParam } from './useUrlParam'

function Probe({ allowed }: { allowed?: readonly string[] }) {
  const [v, set] = useUrlParam('f', 'all', allowed)
  const loc = useLocation()
  return (
    <div>
      <span data-testid="v">{v}</span>
      <span data-testid="loc">{loc.search}</span>
      <button onClick={() => set('x')}>x</button>
      <button onClick={() => set('all')}>all</button>
    </div>
  )
}

const renderAt = (url: string, allowed?: readonly string[]) =>
  render(<MemoryRouter initialEntries={[url]}><Probe allowed={allowed} /></MemoryRouter>)

describe('useUrlParam', () => {
  it('returns the default when absent and the URL value when present', () => {
    renderAt('/p')
    expect(screen.getByTestId('v')).toHaveTextContent('all')
  })

  it('reads the value from the URL', () => {
    renderAt('/p?f=y')
    expect(screen.getByTestId('v')).toHaveTextContent('y')
  })

  it('sets the param, keeps others and removes it at the default', async () => {
    renderAt('/p?table=dev')
    await userEvent.click(screen.getByText('x'))
    expect(screen.getByTestId('loc')).toHaveTextContent('?table=dev&f=x')
    await userEvent.click(screen.getByText('all'))
    expect(screen.getByTestId('loc').textContent).toBe('?table=dev')
  })

  it('falls back to the default for a value outside allowed', () => {
    renderAt('/p?f=bogus', ['all', 'x'])
    expect(screen.getByTestId('v')).toHaveTextContent('all')
  })
})
