import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
vi.mock('./pages/Dashboard', () => ({ DashboardPage: () => <h2>Dashboard stub</h2> }))
vi.mock('./pages/Fleet', () => ({ FleetPage: () => <h2>Fleet stub</h2> }))
vi.mock('./pages/ScheduleDetail', () => ({ ScheduleDetailPage: () => <h2>Schedule detail stub</h2> }))

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)
}

describe('App shell accessibility', () => {
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
    await screen.findByText('Schedule detail stub')
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
