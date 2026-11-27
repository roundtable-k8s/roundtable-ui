import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { RunsPage } from './Runs'

const runs = [
  { run: 'r1', chain: 'nightly', namespace: 'rt', phase: 'Running', source: 'gateway', ageSeconds: 7200, runningSeconds: 300 },
  { run: 'r2', chain: 'pickup-chain', namespace: 'rt', phase: 'Succeeded', source: 'pickup', ageSeconds: 90, issue: { repo: 'acme/app', number: 12 } },
  { run: 'r3', chain: 'bad', namespace: 'rt', phase: 'Failed', source: 'trigger', ageSeconds: 10, issue: { repo: 'evil.com/x/y', number: 3 } },
]

let state: { data: unknown; error: string | null; loading: boolean } = { data: { runs }, error: null, loading: false }
const urls: string[] = []
vi.mock('../hooks/usePolledFetch', () => ({
  usePolledFetch: (url: string) => { urls.push(url); return { ...state, updatedAt: null, refresh: vi.fn() } },
}))
vi.mock('../components/TraceLink', () => ({ TraceLink: () => null }))

afterEach(() => { state = { data: { runs }, error: null, loading: false }; urls.length = 0 })

function Loc() { return <div data-testid="loc">{useLocation().search}</div> }
const renderPage = (url = '/runs') =>
  render(<MemoryRouter initialEntries={[url]}><RunsPage /><Loc /></MemoryRouter>)

describe('RunsPage', () => {
  it('shows runs with age and running time', () => {
    renderPage()
    expect(screen.getByText('running 5m')).toBeTruthy()
    expect(screen.getByText('1m')).toBeTruthy()
  })
  it('links pickup issue safely and not invalid repos', () => {
    renderPage()
    const a = screen.getByRole('link', { name: /acme\/app#12/ })
    expect(a.getAttribute('href')).toBe('https://github.com/acme/app/issues/12')
    expect(a.getAttribute('rel')).toContain('noopener')
    expect(screen.queryByRole('link', { name: /evil\.com/ })).toBeNull()
    expect(screen.getByText('evil.com/x/y#3')).toBeTruthy()
  })
  it('source filter changes request and URL', () => {
    renderPage()
    expect(urls.at(-1)).toBe('/api/gateway/runs?source=all&limit=100')
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'pickup' } })
    expect(screen.getByTestId('loc').textContent).toBe('?source=pickup')
    expect(urls.at(-1)).toBe('/api/gateway/runs?source=pickup&limit=100')
  })
  it('active only filter', () => {
    renderPage()
    fireEvent.click(screen.getByLabelText('Active only'))
    expect(screen.getByTestId('loc').textContent).toBe('?active=true')
    expect(urls.at(-1)).toContain('active=true')
  })
  it('phase filter narrows rows', () => {
    renderPage('/runs?phase=Failed')
    expect(urls.at(-1)).toContain('phase=Failed')
    expect(screen.queryByText('pickup-chain')).toBeNull()
    expect(screen.getByText('bad')).toBeTruthy()
  })
  it('renders empty and error states', () => {
    state = { data: { runs: [] }, error: null, loading: false }
    const { unmount } = renderPage()
    expect(screen.getByTestId('list-empty')).toBeTruthy()
    unmount()
    state = { data: { runs: [] }, error: 'boom', loading: false }
    renderPage()
    expect(screen.getByText(/Failed to load runs: boom/)).toBeTruthy()
  })
})
