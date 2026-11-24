import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
vi.mock('../lib/api', () => ({
  apiGet: (url: string) => Promise.resolve(url === '/api/tasks' ? { results: [], tables } : { fleetPrefix: 'fleet-a' }),
  apiPost: (...args: unknown[]) => apiPost(...args),
}))
vi.mock('../hooks/useFleet', () => ({ useFleet: () => ({ knights, error: null }) }))
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ events }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ addToast: vi.fn() }) }))

beforeEach(() => {
  apiPost.mockReset()
  apiPost.mockResolvedValue({ task_id: 'rt-ui-ui-1', table: 'roundtable-dev' })
})

describe('TasksPage', () => {
  it('shows tasks from every table, each labelled with its table', async () => {
    render(<TasksPage />)
    const history = screen.getByTestId('task-history')
    await waitFor(() => expect(within(history).getAllByTestId('task-row')).toHaveLength(2))
    const labels = within(history).getAllByTestId('table-badge').map((b) => b.textContent)
    expect(labels).toEqual(['roundtable-dev', 'fleet-a'])
  })

  it('filters history by table', async () => {
    render(<TasksPage />)
    const filter = await screen.findByLabelText('Table', { selector: '#table-filter' })
    await userEvent.selectOptions(filter, 'fleet-a')
    const rows = within(screen.getByTestId('task-history')).getAllByTestId('task-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('t1')
  })

  it("dispatches to the knight's own table by default", async () => {
    render(<TasksPage />)
    const tableSelect = await screen.findByLabelText('Table', { selector: '#dispatch-table' })
    expect((tableSelect as HTMLSelectElement).value).toBe('fleet-a') // galahad's table

    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'rt-ui')
    expect((tableSelect as HTMLSelectElement).value).toBe('roundtable-dev')
    expect(screen.getByText('rt-dev.tasks.ui.*')).toBeTruthy()

    await userEvent.type(screen.getByRole('textbox'), 'fix it{Enter}')
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect(apiPost).toHaveBeenCalledWith('/api/tasks/dispatch', {
      knight: 'rt-ui', domain: 'ui', task: 'fix it', table: 'roundtable-dev',
    })
  })

  it('lets the user dispatch to another table', async () => {
    render(<TasksPage />)
    const tableSelect = await screen.findByLabelText('Table', { selector: '#dispatch-table' })
    await userEvent.selectOptions(tableSelect, 'roundtable-dev')
    await userEvent.type(screen.getByRole('textbox'), 'hello{Enter}')
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect(apiPost.mock.calls[0][1]).toMatchObject({ knight: 'galahad', table: 'roundtable-dev' })
  })
})
