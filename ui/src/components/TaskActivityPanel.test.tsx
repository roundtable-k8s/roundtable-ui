import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, fireEvent, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { TaskActivityPanel } from './TaskActivityPanel'
import type { NatsEvent } from '../hooks/useWebSocket'

let listener: ((data: unknown) => void) | null = null
const send = vi.fn(() => true)
let feed: NatsEvent[] = []
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connected: true,
    events: feed,
    send,
    subscribeTopic: (_t: string, fn: (d: unknown) => void) => {
      listener = fn
      return () => { listener = null }
    },
  }),
}))

const apiGet = vi.fn()
vi.mock('../lib/api', () => ({ apiGet: (...a: unknown[]) => apiGet(...a) }))

const T = 'task-1'
const ev = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({
  v: 1, type, seq, taskId: T, knight: 'Galahad', pod: 'galahad-abc', runId: 'run-9', chainName: 'pr', stepName: 'impl',
  model: 'opus', ts: '2026-11-24T10:00:00.000Z', ...extra,
})
const push = (data: unknown) => act(() => listener!(data))

function renderPanel() {
  return render(
    <MemoryRouter>
      <TaskActivityPanel taskId={T} onClose={() => {}} />
    </MemoryRouter>,
  )
}

/** jsdom has no layout: fake the scroll geometry of the timeline. */
function fakeScroll(el: HTMLElement, { scrollHeight, clientHeight }: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
}

beforeEach(() => {
  listener = null
  feed = []
  send.mockClear()
  apiGet.mockReset()
  apiGet.mockResolvedValue({ podName: 'galahad-abc' })
})

describe('TaskActivityPanel', () => {
  it('subscribes, renders the backlog then live events with header details', () => {
    renderPanel()
    expect(send).toHaveBeenCalledWith({ subscribe: 'activity', taskId: T })
    push({ op: 'backlog', taskId: T, events: [
      ev(1, 'task.started'),
      ev(2, 'assistant.message', { preview: 'I will run the tests' }),
      ev(3, 'tool.started', { tool: 'Bash', toolCallId: 'c1', argsSummary: 'npm test' }),
    ] })
    const header = screen.getByLabelText('Task details')
    expect(within(header).getByText('galahad-abc')).toBeInTheDocument()
    expect(within(header).getByText('run-9')).toBeInTheDocument()
    expect(within(header).getByText('opus')).toBeInTheDocument()
    expect(within(header).getByRole('link')).toHaveAttribute('href', '/chains?chain=pr')
    expect(screen.getByText('I will run the tests')).toBeInTheDocument()
    expect(screen.getByText('running…')).toBeInTheDocument()

    push({ op: 'event', taskId: T, event: ev(4, 'tool.finished', { tool: 'Bash', toolCallId: 'c1', durationMs: 4200, isError: true, outputPreview: 'exit 1' }) })
    push({ op: 'event', taskId: T, event: ev(5, 'task.heartbeat', { costUsd: 0.42 }) })
    const tool = document.querySelector('[data-kind="tool"]')!
    expect(tool).toHaveAttribute('data-state', 'error')
    expect(within(tool as HTMLElement).getByText('4.2s')).toBeInTheDocument()
    expect(within(tool as HTMLElement).getByText('exit 1')).toBeInTheDocument()
    expect(within(header).getByText('$0.42')).toBeInTheDocument()
  })

  it('shows gap and truncation markers', () => {
    renderPanel()
    push({ op: 'backlog', taskId: T, truncated: 37, events: [ev(38, 'assistant.message', { preview: 'a' }), ev(41, 'assistant.message', { preview: 'b' })] })
    expect(screen.getByText('37 earlier events no longer buffered')).toBeInTheDocument()
    expect(screen.getByText('2 events missed (seq 39–40)')).toBeInTheDocument()
    push({ op: 'gap', taskId: T, fromSeq: 42, toSeq: 42, count: 1 })
    expect(screen.getByText('1 event missed (seq 42)')).toBeInTheDocument()
  })

  it('renders hostile content as inert text', () => {
    renderPanel()
    push({ op: 'backlog', taskId: T, events: [
      ev(1, 'assistant.message', { preview: '<img src=x onerror=alert(1)> [x](javascript:alert(1)) \u001b[31mred' }),
    ] })
    const timeline = screen.getByLabelText('Activity timeline')
    expect(timeline.querySelector('img')).toBeNull()
    expect(timeline.querySelector('a')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)> [x](javascript:alert(1)) red')).toBeInTheDocument()
  })

  it('auto-scrolls to new events, pauses while scrolled up, and resumes', () => {
    renderPanel()
    const box = screen.getByTestId('activity-timeline')
    fakeScroll(box, { scrollHeight: 1000, clientHeight: 200 })
    push({ op: 'backlog', taskId: T, events: [ev(1, 'task.started')] })
    expect(box.scrollTop).toBe(1000)

    // user scrolls up
    box.scrollTop = 100
    fireEvent.scroll(box)
    fakeScroll(box, { scrollHeight: 1200, clientHeight: 200 })
    push({ op: 'event', taskId: T, event: ev(2, 'assistant.message', { preview: 'more' }) })
    expect(box.scrollTop).toBe(100)
    const resume = screen.getByRole('button', { name: /1 new — resume auto-scroll/ })

    fireEvent.click(resume)
    expect(box.scrollTop).toBe(1200)
    expect(screen.queryByRole('button', { name: /resume auto-scroll/ })).not.toBeInTheDocument()
    fakeScroll(box, { scrollHeight: 1400, clientHeight: 200 })
    push({ op: 'event', taskId: T, event: ev(3, 'assistant.message', { preview: 'again' }) })
    expect(box.scrollTop).toBe(1400)
  })

  it('after finish links the result and the transcript while the pod exists', async () => {
    feed = [{ type: 'result', subject: 'fleet.results.task-1', timestamp: '2026-11-24T10:01:00Z', data: { task_id: T, knight: 'Galahad', success: true, result: 'All done' } }]
    renderPanel()
    push({ op: 'backlog', taskId: T, finished: true, events: [ev(1, 'task.started'), ev(2, 'task.finished', { success: true, durationMs: 60000 })] })
    expect(screen.getByText('All done')).toBeInTheDocument()
    const link = await screen.findByRole('link', { name: 'Open full session transcript' })
    expect(link).toHaveAttribute('href', '/sessions?knight=galahad&pod=galahad-abc&runId=run-9')
    expect(apiGet).toHaveBeenCalledWith('/api/fleet/galahad')
  })

  it('says the transcript is gone when the pod no longer exists', async () => {
    apiGet.mockResolvedValue({ podName: 'galahad-new' })
    renderPanel()
    push({ op: 'backlog', taskId: T, finished: true, events: [ev(1, 'task.finished', { success: false, errorClass: 'timeout' })] })
    await waitFor(() => expect(screen.getByText(/Session transcript unavailable/)).toBeInTheDocument())
    expect(screen.getByText('Task failed')).toBeInTheDocument()
  })

  it('unsubscribes on unmount', () => {
    const { unmount } = renderPanel()
    unmount()
    expect(send).toHaveBeenCalledWith({ unsubscribe: 'activity', taskId: T })
  })
})
