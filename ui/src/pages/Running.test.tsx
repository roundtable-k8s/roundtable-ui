import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { RunningPage } from './Running'
import type { RunningTask } from '../lib/running'
import type { RunningState } from '../hooks/useRunning'

const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString()

const tasks: RunningTask[] = [
  {
    taskId: 'task-run-1', knight: 'galahad', pod: 'galahad-abc', slot: 1, concurrency: 2,
    runId: 'run-1', chainName: 'pr-pipeline', stepName: 'implement', model: 'opus',
    status: 'running', startedAt: iso(125), lastHeartbeat: iso(5), costUsd: 0.42,
    lastTool: { tool: 'Bash', argsSummary: 'npm test' },
  },
  {
    taskId: 'task-stale-1', knight: 'lancelot', pod: 'lancelot-xyz', slot: 0,
    status: 'stale', startedAt: iso(600), lastHeartbeat: iso(200),
  },
  {
    taskId: 'task-lost-1', knight: 'galahad', pod: 'galahad-dead', slot: 0,
    status: 'lost', reason: 'pod deleted', startedAt: iso(900), lastHeartbeat: iso(400),
  },
]

let state: RunningState
const refresh = vi.fn()
vi.mock('../hooks/useRunning', () => ({ useRunning: () => state }))
const send = vi.fn(() => true)
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ connected: true, events: [], send, subscribeTopic: () => () => {} }),
}))

function renderPage(url = '/running') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <RunningPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  state = { tasks: new Map(tasks.map((t) => [t.taskId, t])), loading: false, error: null, unavailable: false, refresh }
})

describe('RunningPage', () => {
  it('lists every in-flight task with its columns', () => {
    renderPage()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    // oldest first
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['lost', 'stale', 'running'])
    const running = within(rows[2])
    expect(running.getByText('galahad-abc')).toBeInTheDocument()
    expect(running.getByText('opus')).toBeInTheDocument()
    expect(running.getByText('Bash')).toBeInTheDocument()
    expect(running.getByText('$0.42')).toBeInTheDocument()
    expect(running.getByText('2m 5s')).toBeInTheDocument()
    expect(running.getByRole('link')).toHaveAttribute('href', '/chains?chain=pr-pipeline')
  })

  it('names the table, scopes headers and hints at Enter on rows', () => {
    renderPage()
    const table = screen.getByRole('table', { name: /running tasks/i })
    expect(table).toHaveAccessibleDescription('Press Enter on a row to open its details')
    for (const th of screen.getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col')
  })

  it('highlights stale and lost rows', () => {
    renderPage()
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows[0].className).toContain('bg-red-500/10')
    expect(rows[1].className).toContain('bg-yellow-500/10')
    expect(rows[2].className).not.toMatch(/bg-(red|yellow)-500\/10/)
  })

  it('filters by knight, status and chain', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.selectOptions(screen.getByLabelText('Filter by knight'), 'galahad')
    expect(screen.getAllByRole('row')).toHaveLength(3)
    await user.selectOptions(screen.getByLabelText('Filter by status'), 'lost')
    expect(screen.getAllByRole('row')).toHaveLength(2)
    await user.selectOptions(screen.getByLabelText('Filter by status'), '')
    await user.selectOptions(screen.getByLabelText('Filter by chain'), 'pr-pipeline')
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-status', 'running')
  })

  it('applies filters from the URL', () => {
    renderPage('/running?status=stale')
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('lancelot')).toBeInTheDocument()
  })

  it('opens the task activity panel on row click', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByText('lancelot-xyz'))
    const dialog = screen.getByRole('dialog', { name: 'Task activity task-stale-1' })
    expect(within(dialog).getByText('lancelot-xyz')).toBeInTheDocument()
    expect(send).toHaveBeenCalledWith({ subscribe: 'activity', taskId: 'task-stale-1' })
    await user.click(within(dialog).getByLabelText('Close'))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(send).toHaveBeenCalledWith({ unsubscribe: 'activity', taskId: 'task-stale-1' })
  })

  it('keeps the panel open after the task leaves the running list', () => {
    const { rerender } = renderPage('/running?task=task-run-1')
    expect(screen.getByRole('dialog', { name: 'Task activity task-run-1' })).toBeInTheDocument()
    state = { ...state, tasks: new Map() }
    rerender(
      <MemoryRouter initialEntries={['/running?task=task-run-1']}>
        <RunningPage />
      </MemoryRouter>,
    )
    const dialog = screen.getByRole('dialog', { name: 'Task activity task-run-1' })
    // header falls back to the last registry entry
    expect(within(dialog).getByText('galahad-abc')).toBeInTheDocument()
  })

  it('shows the lost reason in the panel', () => {
    renderPage('/running?task=task-lost-1')
    expect(screen.getByText('pod deleted')).toBeInTheDocument()
  })

  it('shows counts and an empty state', () => {
    state = { ...state, tasks: new Map() }
    renderPage()
    expect(screen.getByText('Nothing is running right now.')).toBeInTheDocument()
  })

  it('explains when the backend has no running endpoint', () => {
    state = { ...state, tasks: new Map(), unavailable: true }
    renderPage()
    expect(screen.getByText(/does not report running tasks/)).toBeInTheDocument()
  })

  it('offers Retry after a failed load', async () => {
    state = { ...state, tasks: new Map(), error: 'boom' }
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
