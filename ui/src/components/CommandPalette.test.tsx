import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { CommandPalette } from './CommandPalette'

const apiGet = vi.fn()
vi.mock('../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }))
vi.mock('../pages/Chains', () => ({ CHAINS_LIST_URL: '/api/chains?x=1' }))

const data: Record<string, unknown> = {
  '/api/fleet': [{ name: 'galahad', namespace: 'rt' }],
  '/api/chains': [{ name: 'gal-chain', namespace: 'rt' }],
  '/api/schedules': { schedules: [{ name: 'gal-sched', namespace: 'rt' }] },
  '/api/missions': [{ name: 'gal-mission', namespace: 'rt' }],
  '/api/triggers': [{ name: 'gal-trigger', namespace: 'rt' }],
}
let failing = ''

const pages = [{ path: '/fleet', label: 'Fleet' }]
function Harness() {
  const [open, setOpen] = useState(true)
  const loc = useLocation()
  return <>
    <span data-testid="loc">{loc.pathname}{loc.search}</span>
    {open && <CommandPalette onClose={() => setOpen(false)} pages={pages} table="" />}
  </>
}
const renderIt = () => render(<MemoryRouter><Harness /></MemoryRouter>)

beforeEach(() => {
  failing = ''
  apiGet.mockReset()
  apiGet.mockImplementation((url: string) => {
    const key = url.split('?')[0]
    if (key === failing) return Promise.reject(new Error('boom'))
    return Promise.resolve(data[key])
  })
})

describe('CommandPalette', () => {
  it('lists pages first, filters, and Enter navigates and closes', async () => {
    renderIt()
    expect(screen.getByText('Fleet')).toBeTruthy()
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'gal' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(5))
    expect(screen.getByText('knight')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByTestId('loc').textContent).toBe('/chains?chain=gal-chain')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on Escape', () => {
    renderIt()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('still lists the other sources when one fails', async () => {
    failing = '/api/chains'
    renderIt()
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gal' } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4))
    expect(screen.getByRole('alert').textContent).toContain('chains')
  })

  it('fetches each list once', async () => {
    renderIt()
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(5))
  })

  it('does not warn about duplicate keys for same-named entries in two namespaces', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    data['/api/fleet'] = [{ name: 'twin', namespace: 'a' }, { name: 'twin', namespace: 'b' }]
    try {
      renderIt()
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'twin' } })
      await waitFor(() => expect(screen.getAllByRole('option', { name: /twin/ })).toHaveLength(2))
      expect(err.mock.calls.some(c => String(c[0]).includes('same key'))).toBe(false)
    } finally {
      data['/api/fleet'] = [{ name: 'galahad', namespace: 'rt' }]
      err.mockRestore()
    }
  })
})
