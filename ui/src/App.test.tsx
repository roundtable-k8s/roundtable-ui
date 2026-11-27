import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'

vi.mock('./hooks/useWebSocket', () => ({
  useWebSocket: () => ({ events: [], connected: true }),
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('./hooks/useTables', () => ({ useTables: () => [] }))
vi.mock('./hooks/useOpenDeadLetters', () => ({
  useOpenDeadLetters: () => ({ count: 0, capped: false, total: 0, error: false }),
  deadLetterBadge: () => ({ text: '', title: '' }),
}))
let versionResult: { version: string; commit: string } | null = null
vi.mock('./hooks/useVersion', () => ({ useVersion: () => versionResult }))
vi.mock('./pages/Dashboard', () => ({ DashboardPage: () => <h2>Dashboard stub</h2> }))
vi.mock('./pages/Fleet', () => ({ FleetPage: () => <h2>Fleet stub</h2> }))
vi.mock('./pages/ScheduleDetail', () => ({ ScheduleDetailPage: () => <h2>Schedule detail stub</h2> }))

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)
}

describe('App shell accessibility', { timeout: 15000 }, () => {
  it('labels the nav and menu button, and toggles aria-expanded', async () => {
    renderAt('/')
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    const btn = screen.getByRole('button', { name: 'Open menu' })
    expect(btn.getAttribute('aria-expanded')).toBe('false')
    expect(btn.getAttribute('aria-controls')).toBe('main-nav')
    fireEvent.click(btn)
    expect(screen.getByRole('button', { name: 'Close menu' }).getAttribute('aria-expanded')).toBe('true')
  })

  it('closes the open menu on Escape', () => {
    renderAt('/')
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('marks the current page, including nested paths', async () => {
    renderAt('/schedules/ns/name')
    await screen.findByText('Schedule detail stub', {}, { timeout: 4000 })
    expect(screen.getByRole('link', { name: /Schedules/ }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: /Fleet/ }).getAttribute('aria-current')).toBeNull()
    expect(screen.getByRole('link', { name: /Command Center/ }).getAttribute('aria-current')).toBeNull()
  })

  it('has a skip link that focuses main', () => {
    renderAt('/')
    const skip = screen.getByRole('link', { name: 'Skip to content' })
    expect(document.querySelector('a')).toBe(skip)
    fireEvent.click(skip)
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  it('sets the document title from the route and focuses main on navigation', async () => {
    renderAt('/')
    expect(document.title).toBe('Command Center - Round Table')
    fireEvent.click(screen.getByRole('link', { name: /Fleet/ }))
    await screen.findByText('Fleet stub')
    expect(document.title).toBe('Fleet - Round Table')
    expect(document.activeElement).toBe(document.getElementById('main'))
  })

  it('shows a not-found page for unknown paths', () => {
    renderAt('/does-not-exist')
    expect(screen.getByText('Page not found')).toBeTruthy()
    expect(document.title).toBe('Page not found - Round Table')
    expect(screen.getByRole('link', { name: 'Back to Command Center' }).getAttribute('href')).toBe('/')
  })
})

describe('Kubernetes health banner', () => {
  const BANNER = 'Kubernetes unavailable: the dashboard API cannot read cluster state'
  afterEach(() => { vi.unstubAllGlobals() })

  it('warns when /api/health reports kubernetes unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'ok', kubernetes: 'unavailable', nats: 'connected' }), { headers: { 'Content-Type': 'application/json' } })))
    renderAt('/')
    expect((await screen.findByRole('alert')).textContent).toBe(BANNER)
  })

  it('shows no banner when connected', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', kubernetes: 'connected', nats: 'connected' }), { headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', f)
    renderAt('/')
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(screen.queryByText(BANNER)).toBeNull()
  })

  it('shows no banner when the health request fails', async () => {
    const f = vi.fn(async () => new Response('boom', { status: 500 }))
    vi.stubGlobal('fetch', f)
    renderAt('/')
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(screen.queryByText(BANNER)).toBeNull()
  })
})

describe('build version footer', () => {
  it('shows the version and short commit', () => {
    versionResult = { version: '1.2.3', commit: 'abcdef0123456789' }
    renderAt('/')
    expect(screen.getByTestId('build-version').textContent).toBe('v1.2.3 (abcdef0)')
  })

  it('is absent while loading or when the fetch failed', () => {
    versionResult = null
    renderAt('/')
    expect(screen.queryByTestId('build-version')).toBeNull()
  })
})
