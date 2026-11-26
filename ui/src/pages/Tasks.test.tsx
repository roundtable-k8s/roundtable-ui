import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TasksPage } from './Tasks'
import type { NatsEvent } from '../hooks/useWebSocket'

const tables = [
  { name: 'fleet-a', prefix: 'fleet-a' },
  { name: 'roundtable-dev', prefix: 'rt-dev' },
]
const knights = [
  { name: 'galahad', domain: 'security', natsPrefix: 'fleet-a' },
  { name: 'rt-ui', domain: 'ui', natsPrefix: 'rt-dev' },
]
const events: NatsEvent[] = [
  { type: 'result', subject: 'fleet-a.results.t1', table: 'fleet-a', timestamp: '2026-11-24T10:00:00Z',
    data: { task_id: 't1', knight: 'Galahad', success: true, result: 'scan clean' } },
  { type: 'result', subject: 'rt-dev.results.t2', table: 'roundtable-dev', timestamp: '2026-11-24T10:01:00Z',
    data: { task_id: 't2', knight: 'Rt-ui', success: true, result: 'page fixed' } },
]

const apiPost = vi.fn()
const apiGet = vi.fn()
vi.mock('../lib/api', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: (...args: unknown[]) => apiPost(...args),
}))
vi.mock('../hooks/useFleet', () => ({ useFleet: () => ({ knights, error: null }) }))
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))

beforeEach(() => {
  apiPost.mockReset()
  apiGet.mockReset()
  apiGet.mockImplementation((url: string) =>
    Promise.resolve(url === '/api/tasks' ? { results: [], tables } : { taskId: 'invoke-rt-ui-1', status: 'pending' }))
  apiPost.mockResolvedValue({ taskId: 'invoke-rt-ui-1', runId: 'r1', status: 'pending', roundTable: 'dev' })
})

describe('TasksPage', () => {
  it('shows tasks from every table, each labelled with its table', async () => {
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    const history = screen.getByTestId('task-history')
    await waitFor(() => expect(within(history).getAllByTestId('task-row')).toHaveLength(2))
    const labels = within(history).getAllByTestId('table-badge').map((b) => b.textContent)
    expect(labels).toEqual(['roundtable-dev', 'fleet-a'])
  })

  it('filters history by the shared ?table= parameter', async () => {
    render(<MemoryRouter initialEntries={['/quests?table=fleet-a']}><TasksPage /></MemoryRouter>)
    await waitFor(() => expect(within(screen.getByTestId('task-history')).getAllByTestId('task-row')).toHaveLength(1))
    const rows = within(screen.getByTestId('task-history')).getAllByTestId('task-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('t1')
  })

  it('dispatches to the picked knight through the gateway proxy, without a domain or table', async () => {
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    expect(screen.queryByLabelText('Table', { selector: '#dispatch-table' })).toBeNull()

    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'rt-ui')
    await userEvent.type(screen.getByRole('textbox'), 'fix it{Enter}')
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect(apiPost).toHaveBeenCalledWith('/api/tasks/dispatch', { knight: 'rt-ui', task: 'fix it' })
    expect(await screen.findByText('invoke-rt-ui-1')).toBeTruthy()
    expect(screen.getByTestId('dispatch-status').textContent).toBe('pending')
  })

  it('polls the task and shows its status and output', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/tasks') return Promise.resolve({ results: [], tables })
      return Promise.resolve({ taskId: 'invoke-rt-ui-1', status: 'succeeded', output: 'page fixed' })
    })
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    await userEvent.type(await screen.findByRole('textbox'), 'fix it{Enter}')
    await waitFor(() => expect(screen.getByTestId('dispatch-status').textContent).toBe('succeeded'), { timeout: 5000 })
    expect(apiGet).toHaveBeenCalledWith('/api/tasks/dispatch/invoke-rt-ui-1', expect.anything())
    expect(screen.getByTestId('dispatch-output').textContent).toBe('page fixed')
  })
})
