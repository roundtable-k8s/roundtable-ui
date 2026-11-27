import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import type { NatsEvent } from './hooks/useWebSocket'

let wsEvents: NatsEvent[] = []
vi.mock('./hooks/useWebSocket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./hooks/useWebSocket')>()),
  useWebSocket: () => ({ events: wsEvents, connected: true }),
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
  afterEach(() => {
    vi.restoreAllMocks()
    wsEvents = []
  })

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

  it('prefixes the title with the count of results that finished while the tab was hidden', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const { rerender } = renderAt('/')
    wsEvents = [
      { type: 'result', subject: 'fleet-a.results.t1', data: { knight: 'galahad', success: true }, timestamp: 't1', live: true },
      { type: 'result', subject: 'fleet-a.results.t2', data: { knight: 'galahad', success: false, result: 'boom' }, timestamp: 't2', live: true },
    ]
    rerender(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
    expect(document.title).toBe('(2, 1 failed) Command Center - Round Table')
  })

  it('shows a not-found page for unknown paths', () => {
    renderAt('/does-not-exist')
    expect(screen.getByText('Page not found')).toBeTruthy()
    expect(document.title).toBe('Page not found - Round Table')
    expect(screen.getByRole('link', { name: 'Back to Command Center' }).getAttribute('href')).toBe('/')
  })

  it('renders the not-found title as h1 and keeps ?table= on the way back', () => {
    renderAt('/does-not-exist?table=dev')
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to Command Center' }).getAttribute('href')).toBe('/?table=dev')
  })

  it('does not focus main on first load, even when effects run twice (StrictMode)', () => {
    render(<React.StrictMode><MemoryRouter initialEntries={['/']}><App /></MemoryRouter></React.StrictMode>)
    expect(document.activeElement).not.toBe(document.getElementById('main'))
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

  it('hides the banner after a failed later poll', async () => {
    vi.useFakeTimers()
    try {
      let healthCalls = 0
      const f = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/api/health') && healthCalls++ === 0) {
          return new Response(JSON.stringify({ status: 'ok', kubernetes: 'unavailable', nats: 'connected' }), { headers: { 'Content-Type': 'application/json' } })
        }
        return new Response('boom', { status: 500 })
      })
      vi.stubGlobal('fetch', f)
      renderAt('/')
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('alert').textContent).toBe(BANNER)
      await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
      expect(healthCalls).toBeGreaterThanOrEqual(2)
      expect(screen.queryByText(BANNER)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
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
  beforeEach(() => { versionResult = null })

  it('shows the version and short commit', () => {
    versionResult = { version: '1.2.3', commit: 'abcdef0123456789' }
    renderAt('/')
    expect(screen.getByTestId('build-version').textContent).toBe('v1.2.3 (abcdef0)')
  })

  it('is absent while loading or when the fetch failed', () => {
    renderAt('/')
    expect(screen.queryByTestId('build-version')).toBeNull()
  })
})

describe('command palette shortcut', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const SOURCES = ['/api/fleet', '/api/schedules', '/api/missions', '/api/triggers']
  const fetched = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => String(c[0]))
  const paletteFetches = (f: ReturnType<typeof vi.fn>) => fetched(f).filter((u) => SOURCES.some((s) => u.startsWith(s)))

  it('does not fetch before first open, then opens on Ctrl+K', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('[]')))
    vi.stubGlobal('fetch', f)
    renderAt('/')
    expect(paletteFetches(f)).toEqual([])
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(await screen.findByRole('dialog', { name: 'Search' })).toBeTruthy()
    await waitFor(() => expect(paletteFetches(f).length).toBeGreaterThan(0))
  })

  it('ignores Ctrl+K while typing in an input', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('[]')))
    vi.stubGlobal('fetch', f)
    renderAt('/')
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      input.focus()
      fireEvent.keyDown(input, { key: 'k', ctrlKey: true })
      // Let any deferred palette open/fetch run before asserting it did not happen.
      await act(() => new Promise((r) => setTimeout(r, 20)))
      expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull()
      expect(paletteFetches(f)).toEqual([])
    } finally {
      input.remove()
    }
  })
})
