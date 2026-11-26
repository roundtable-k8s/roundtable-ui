import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import type { OpenDeadLetters } from './hooks/useOpenDeadLetters'

const dead = vi.hoisted(() => ({ current: { count: 0, capped: false } as OpenDeadLetters }))
vi.mock('./hooks/useOpenDeadLetters', async (orig) => ({
  ...(await orig<typeof import('./hooks/useOpenDeadLetters')>()),
  useOpenDeadLetters: () => dead.current,
}))
vi.mock('./hooks/useWebSocket', () => ({
  useWebSocket: () => ({ events: [], connected: true }),
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
vi.mock('./hooks/useTaskNotifications', () => ({ useTaskNotifications: () => {} }))
vi.mock('./hooks/useTables', () => ({ useTables: () => ({ tables: [], loading: false, error: null }) }))

function renderApp() {
  return render(<MemoryRouter initialEntries={['/architecture']}><App /></MemoryRouter>)
}

describe('App dead-letter nav badge', () => {
  it('shows "?" titled "dead-letter count unavailable" when the count failed', () => {
    dead.current = { count: 0, capped: false, error: true }
    renderApp()
    const badge = screen.getByTitle('dead-letter count unavailable')
    expect(badge).toHaveTextContent('?')
  })

  it('shows the count when there are open dead letters', () => {
    dead.current = { count: 3, capped: false }
    renderApp()
    expect(screen.getByTitle('3 open')).toHaveTextContent('3')
  })

  it('hides the badge at zero without an error', () => {
    dead.current = { count: 0, capped: false }
    renderApp()
    expect(screen.queryByTitle('0 open')).not.toBeInTheDocument()
    expect(screen.queryByTitle('dead-letter count unavailable')).not.toBeInTheDocument()
  })
})
