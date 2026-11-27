import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { TasksPage } from './Tasks'
import type { NatsEvent } from '../hooks/useWebSocket'
import { resetConfigCache } from '../hooks/useConfig'

const tables = [
  { name: 'fleet-a', prefix: 'fleet-a' },
  { name: 'roundtable-dev', prefix: 'rt-dev' },
]
const knights = [
  { name: 'galahad', domain: 'security', natsPrefix: 'fleet-a' },
  { name: 'rt-ui', domain: 'ui', natsPrefix: 'rt-dev', namespace: 'team-b' },
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
    Promise.resolve(url === '/api/tables' ? { tables } : { taskId: 'invoke-rt-ui-1', status: 'pending' }))
  apiPost.mockResolvedValue({ taskId: 'invoke-rt-ui-1', runId: 'r1', status: 'pending', roundTable: 'dev' })
})

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => {
  vi.useRealTimers()
  // drop the own-property override so jsdom's prototype getter applies again
  delete (document as unknown as { hidden?: boolean }).hidden
})

describe('TasksPage trace link', () => {
  const TRACE = '0af7651916cd43dd8448eb211c80319c'
  const configure = (cfg: Record<string, unknown>) => {
    resetConfigCache()
    apiGet.mockImplementation((url: string) =>
      url === '/api/tables' ? Promise.resolve({ tables })
        : url === '/api/config' ? Promise.resolve(cfg)
          : Promise.resolve({ taskId: 'invoke-rt-ui-1', status: 'succeeded', traceId: TRACE }))
    apiPost.mockResolvedValueOnce({ taskId: 'invoke-rt-ui-1', runId: 'r1', status: 'pending', traceId: TRACE })
  }
  const dispatch = async () => {
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'rt-ui')
    await userEvent.type(screen.getByLabelText('Quest'), 'fix it{Enter}')
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    await screen.findByText('invoke-rt-ui-1')
  }

  it('links a dispatched task to its trace when a trace URL template is configured', async () => {
    configure({ traceUrlTemplate: 'https://t.example/trace/{traceId}' })
    await dispatch()
    const link = await screen.findByRole('link', { name: /View trace/ }, { timeout: 8000 })
    expect(link).toHaveAttribute('href', `https://t.example/trace/${TRACE}`)
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  }, 15000)

  it('shows no trace link without a configured template', async () => {
    configure({})
    await dispatch()
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/config'))
    expect(screen.queryByRole('link', { name: /View trace/ })).toBeNull()
  }, 15000)
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

    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'rt-ui')
    await userEvent.type(screen.getByLabelText('Quest'), 'fix it{Enter}')
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
    expect(apiPost).toHaveBeenCalledWith('/api/tasks/dispatch', { knight: 'rt-ui', task: 'fix it', namespace: 'team-b' }, { headers: { 'Idempotency-Key': expect.any(String) } })
    expect(await screen.findByText('invoke-rt-ui-1')).toBeTruthy()
    expect(screen.getByTestId('dispatch-status').textContent).toBe('pending')
  })

  it('keeps the key for a retry after a 5xx and ignores a click while in flight', async () => {
    apiPost.mockRejectedValueOnce(Object.assign(new Error('bad gateway'), { status: 502 }))
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'rt-ui')
    await userEvent.type(screen.getByLabelText('Quest'), 'fix it')
    const btn = screen.getByRole('button', { name: /dispatch/i })
    await userEvent.click(btn)
    await waitFor(() => expect(btn).not.toBeDisabled())
    await userEvent.click(btn)
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
    const keys = apiPost.mock.calls.map((c) => c[2].headers['Idempotency-Key'])
    expect(keys[1]).toBe(keys[0])
  })

  it('stops polling a task after 5 consecutive failed polls and marks it unavailable', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/api/tables' ? Promise.resolve({ tables }) : Promise.reject(new Error('404')))
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    await userEvent.type(await screen.findByRole('textbox'), 'fix it{Enter}')
    const polls = () => apiGet.mock.calls.filter((c) => String(c[0]).startsWith('/api/tasks/dispatch/')).length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500) })
    expect(screen.getByTestId('dispatch-status').textContent).toBe('status unavailable')
    expect(polls()).toBe(5)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(polls()).toBe(5)
  })

  it('polls the task and shows its status and output', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/tables') return Promise.resolve({ tables })
      return Promise.resolve({ taskId: 'invoke-rt-ui-1', status: 'succeeded', output: 'page fixed' })
    })
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    await userEvent.type(await screen.findByRole('textbox'), 'fix it{Enter}')
    await waitFor(() => expect(screen.getByTestId('dispatch-status').textContent).toBe('succeeded'), { timeout: 5000 })
    expect(apiGet).toHaveBeenCalledWith('/api/tasks/dispatch/invoke-rt-ui-1', expect.anything())
    expect(screen.getByTestId('dispatch-output').textContent).toBe('page fixed')
  })

  it('pauses polling a dispatched task in a hidden tab and resumes when visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    await userEvent.type(await screen.findByRole('textbox'), 'fix it{Enter}')
    expect(await screen.findByText('invoke-rt-ui-1')).toBeTruthy()
    const polls = () => apiGet.mock.calls.filter((c) => String(c[0]).startsWith('/api/tasks/dispatch/')).length

    await act(async () => { setHidden(true) })
    const before = polls()
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(polls()).toBe(before)

    await act(async () => { setHidden(false) })
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(polls()).toBeGreaterThan(before)
  })
})

describe('TasksPage gateway record', () => {
  const dispatchWith = async (record: Record<string, unknown>) => {
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/tables' ? { tables } : { taskId: 'invoke-rt-ui-1', ...record }))
    render(<MemoryRouter><TasksPage /></MemoryRouter>)
    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'rt-ui')
    await userEvent.type(screen.getByLabelText('Quest'), 'fix it{Enter}')
    await waitFor(() => expect(apiPost).toHaveBeenCalled())
  }

  it('shows usage, pull requests and verdict of a full record', async () => {
    await dispatchWith({
      status: 'succeeded', output: 'done', model: 'opus', requestedModel: 'sonnet', cost: 0.75, billing: 'subscription',
      tokens: { input: 10000, output: 1500 }, turns: 3, toolCalls: 7, durationMs: 65000, verdict: 'approve',
      prs: [
        { repo: 'a/b', number: 5, url: 'https://github.com/a/b/pull/5', action: 'opened' },
        { number: 6, url: 'https://github.com/a/c/pull/6', action: 'merged' },
      ],
    })
    const usage = await screen.findByTestId('dispatch-usage', {}, { timeout: 8000 })
    expect(usage).toHaveTextContent('opus (requested sonnet)')
    expect(usage).toHaveTextContent('$0.75')
    expect(usage).toHaveTextContent('10k in / 1.5k out')
    expect(usage).toHaveTextContent('3 turns')
    expect(usage).toHaveTextContent('7 tool calls')
    expect(usage).toHaveTextContent('1m 5s')
    expect(screen.getByRole('link', { name: 'a/b#5 (opened)' })).toHaveAttribute('href', 'https://github.com/a/b/pull/5')
    expect(screen.getByRole('link', { name: '#6 (merged)' })).toBeInTheDocument()
    expect(screen.getByTestId('dispatch-verdict')).toHaveTextContent('approve')
  }, 15000)

  it('renders a record without usage as before', async () => {
    await dispatchWith({ status: 'succeeded', output: 'done' })
    await screen.findByTestId('dispatch-output', {}, { timeout: 8000 })
    expect(screen.queryByTestId('dispatch-usage')).toBeNull()
    expect(screen.queryByTestId('dispatch-prs')).toBeNull()
    expect(screen.queryByTestId('dispatch-verdict')).toBeNull()
  }, 15000)

  it('shows a usage-limit refusal instead of the bare failure', async () => {
    await dispatchWith({ status: 'failed', error: 'quota exceeded', usageLimited: true })
    await screen.findByText('Usage limit reached: retry later', {}, { timeout: 8000 })
    expect(screen.queryByText('quota exceeded')).toBeNull()
  }, 15000)

  it('does not link a javascript: pull request URL', async () => {
    await dispatchWith({ status: 'succeeded', output: 'done', prs: [{ number: 9, url: 'javascript:alert(1)', action: 'opened' }] })
    await screen.findByText('#9 (opened)', {}, { timeout: 8000 })
    expect(screen.queryByRole('link', { name: /#9/ })).toBeNull()
  }, 15000)
})
