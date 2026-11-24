import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TaskActivityPanel } from './TaskActivityPanel'
import type { NatsEvent } from '../hooks/useWebSocket'

type Listener = (data: unknown) => void
const listeners = new Map<string, Listener>()
const watchActivity = vi.fn((taskId: string, fn: Listener) => {
  listeners.set(taskId, fn)
  return () => { listeners.delete(taskId) }
})
let events: NatsEvent[] = []
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({ connected: true, events, watchActivity }),
}))
const apiGet = vi.fn()
vi.mock('../lib/api', () => ({ apiGet: (...args: unknown[]) => apiGet(...args) }))

const header = { taskId: 't1', knight: 'Galahad', pod: 'galahad-abc', runId: 'run-9', chainName: 'pr-pipeline', stepName: 'implement', model: 'opus', seq: 3, costUsd: 0.25, startedAt: new Date(Date.now() - 65_000).toISOString() }

function push(taskId: string, data: unknown) {
  act(() => listeners.get(taskId)!(data))
}

function renderPanel(taskId = 't1') {
  return render(
    <MemoryRouter>
      <TaskActivityPanel taskId={taskId} onClose={() => {}} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  listeners.clear()
  watchActivity.mockClear()
  apiGet.mockReset()
  events = []
})

describe('TaskActivityPanel', () => {
  it('shows the header, backlog, then live events with gap and truncation markers', () => {
    renderPanel()
    expect(watchActivity).toHaveBeenCalledWith('t1', expect.any(Function))
    expect(screen.getByText('Loading activity…')).toBeInTheDocument()

    push('t1', {
      op: 'backlog', taskId: 't1', task: header, dropped: 4,
      events: [
        { type: 'task.started', seq: 1, ts: '' },
        { type: 'tool.started', seq: 2, ts: '', tool: 'bash', toolCallId: 'c1', argsSummary: 'npm test' },
        { type: 'assistant.message', seq: 3, ts: '', preview: 'Running tests', truncated: true },
      ],
    })
    const dialog = screen.getByRole('dialog', { name: 'Task t1' })
    expect(within(dialog).getByText('galahad-abc')).toBeInTheDocument()
    expect(within(dialog).getByText('run-9')).toBeInTheDocument()
    expect(within(dialog).getByText('$0.25')).toBeInTheDocument()
    expect(within(dialog).getByText(/4 earlier events no longer buffered/)).toBeInTheDocument()
    expect(within(dialog).getByText('npm test')).toBeInTheDocument()
    expect(within(dialog).getByText('truncated')).toBeInTheDocument()
    expect(dialog.querySelector('[data-kind="tool"]')).toHaveAttribute('data-state', 'running')

    // Live: the tool finishes with an error, then seq 5-6 never arrive.
    push('t1', { op: 'event', taskId: 't1', task: header, event: { type: 'tool.finished', seq: 4, ts: '', tool: 'bash', toolCallId: 'c1', durationMs: 2300, isError: true, outputPreview: 'exit 1' } })
    push('t1', { op: 'event', taskId: 't1', event: { type: 'assistant.message', seq: 7, ts: '', preview: 'Fixing' } })
    expect(dialog.querySelector('[data-kind="tool"]')).toHaveAttribute('data-state', 'error')
    expect(within(dialog).getByText('2.3s')).toBeInTheDocument()
    expect(within(dialog).getByText('exit 1')).toBeInTheDocument()
    expect(within(dialog).getByText(/2 events missing here/)).toBeInTheDocument()
    expect(within(dialog).getByText('Fixing')).toBeInTheDocument()
  })

  it('renders hostile content as inert text', () => {
    renderPanel()
    push('t1', {
      op: 'backlog', taskId: 't1', task: header,
      events: [{ type: 'assistant.message', seq: 1, ts: '', preview: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) \u001b[31mred' }],
    })
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.querySelector('a[href^="javascript"]')).toBeNull()
    expect(within(dialog).getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('\u001b')
  })

  it('pauses auto-scroll while scrolled up and resumes on demand', () => {
    renderPanel()
    push('t1', { op: 'backlog', taskId: 't1', task: header, events: [{ type: 'task.started', seq: 1, ts: '' }] })
    const list = screen.getByTestId('activity-timeline')
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 })

    push('t1', { op: 'event', taskId: 't1', event: { type: 'assistant.message', seq: 2, ts: '', preview: 'a' } })
    expect(list.scrollTop).toBe(1000)

    list.scrollTop = 100
    fireEvent.scroll(list)
    const follow = screen.getByRole('button', { name: /Follow live/ })
    push('t1', { op: 'event', taskId: 't1', event: { type: 'assistant.message', seq: 3, ts: '', preview: 'b' } })
    expect(list.scrollTop).toBe(100)

    fireEvent.click(follow)
    expect(list.scrollTop).toBe(1000)
    expect(screen.queryByRole('button', { name: /Follow live/ })).not.toBeInTheDocument()
  })

  it('links the result and the transcript after the task finishes', async () => {
    apiGet.mockResolvedValue({ podName: 'galahad-abc' })
    events = [{ type: 'result', subject: 'fleet.results.t1', data: { task_id: 't1', knight: 'Galahad', success: true, result: 'All green' }, timestamp: '' }]
    renderPanel()
    push('t1', {
      op: 'backlog', taskId: 't1',
      task: { ...header, finished: true, success: true, durationMs: 90_000, finishedAt: new Date().toISOString() },
      events: [{ type: 'task.finished', seq: 9, ts: '', success: true, durationMs: 90_000 }],
    })
    expect(screen.getByText('All green')).toBeInTheDocument()
    expect(screen.getByText('1m 30s')).toBeInTheDocument()
    const link = await screen.findByRole('link', { name: /session transcript/ })
    expect(link).toHaveAttribute('href', '/sessions?knight=galahad')
    expect(apiGet).toHaveBeenCalledWith('/api/fleet/galahad', expect.anything())
  })

  it('says when the pod is gone', async () => {
    apiGet.mockResolvedValue({ podName: 'galahad-new' })
    renderPanel()
    push('t1', { op: 'backlog', taskId: 't1', task: { ...header, finished: true, success: false, errorClass: 'timeout' }, events: [] })
    expect(await screen.findByText(/session transcript went with it/)).toBeInTheDocument()
    expect(screen.getAllByText(/failed \(timeout\)/).length).toBeGreaterThan(0)
  })

  it('shows server errors such as the watch limit', () => {
    renderPanel()
    push('t1', { op: 'error', taskId: 't1', error: 'watch_limit' })
    expect(screen.getByRole('alert')).toHaveTextContent(/Too many tasks/)
  })
})
