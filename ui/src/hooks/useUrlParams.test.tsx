import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { useUrlParams } from './useUrlParams'

const DEFAULTS = { a: '', b: 'all' }
const ALLOWED = { b: ['all', 'x', 'y'] as const }

function Probe() {
  const [v, set] = useUrlParams(DEFAULTS, ALLOWED)
  const loc = useLocation()
  const nav = useNavigate()
  return (
    <div>
      <span data-testid="v">{JSON.stringify(v)}</span>
      <span data-testid="loc">{loc.search}</span>
      <span data-testid="path">{loc.pathname}</span>
      <button onClick={() => set({ a: '1', b: 'x' })}>both</button>
      <button onClick={() => set({ a: null, b: 'all' })}>clear</button>
      <button onClick={() => nav(-1)}>back</button>
    </div>
  )
}

const renderAt = (url: string) =>
  render(<MemoryRouter initialEntries={['/start', url]} initialIndex={1}><Probe /></MemoryRouter>)

describe('useUrlParams', () => {
  it('returns the defaults when no param is set', () => {
    renderAt('/p')
    expect(screen.getByTestId('v')).toHaveTextContent('{"a":"","b":"all"}')
  })

  it('falls back to the default for a value outside the allow-list', () => {
    renderAt('/p?a=z&b=nope')
    expect(screen.getByTestId('v')).toHaveTextContent('{"a":"z","b":"all"}')
  })

  it('applies a multi-key patch as one history entry, replacing the current one', async () => {
    renderAt('/p')
    await userEvent.click(screen.getByText('both'))
    expect(screen.getByTestId('loc')).toHaveTextContent('?a=1&b=x')
    expect(screen.getByTestId('path').textContent).toBe('/p')
    await userEvent.click(screen.getByText('back'))
    // replace (not push): back skips past /p and lands on the entry before it
    expect(screen.getByTestId('path').textContent).toBe('/start')
  })

  it('removes params set to the default, empty or null', async () => {
    renderAt('/p?a=1&b=x')
    await userEvent.click(screen.getByText('clear'))
    expect(screen.getByTestId('loc').textContent).toBe('')
  })

  it('preserves unrelated params', async () => {
    renderAt('/p?keep=1&b=y')
    await userEvent.click(screen.getByText('both'))
    expect(screen.getByTestId('loc').textContent).toBe('?keep=1&b=x&a=1')
  })
})
