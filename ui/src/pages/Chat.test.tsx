import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ChatPage, STALE_TURN_MS } from './Chat'
import { parseKnights } from '../lib/chat'
import { resetConfigCache } from '../hooks/useConfig'
import { ApiError } from '../lib/api'

const apiPost = vi.fn()
const apiGet = vi.fn()
vi.mock('../lib/api', async () => ({
  ApiError: (await vi.importActual<typeof import('../lib/api')>('../lib/api')).ApiError,
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
}))
vi.mock('../components/TaskActivityPanel', () => ({
  TaskActivityPanel: ({ taskId }: { taskId: string }) => <div data-testid="activity">{taskId}</div>,
}))

let taskStatus: Record<string, unknown>

beforeEach(() => {
  apiPost.mockReset()
  apiGet.mockReset()
  taskStatus = { taskId: 't1', status: 'pending' }
  apiGet.mockImplementation((url: string) =>
    Promise.resolve(url === '/api/chat/knights' ? { knights: [{ name: 'rt-ui' }, { name: 'galahad' }] } : taskStatus))
  apiPost.mockResolvedValue({ taskId: 't1', runId: 'run-1', status: 'pending' })
})
afterEach(() => { vi.useRealTimers() })

describe('ChatPage', () => {
  const TRACE = '0af7651916cd43dd8448eb211c80319c'
  it('links a reply to its trace when a trace URL template is configured', async () => {
    resetConfigCache()
    apiGet.mockImplementation((url: string) =>
      url === '/api/chat/knights' ? Promise.resolve({ knights: [{ name: 'galahad' }] })
        : url === '/api/config' ? Promise.resolve({ traceUrlTemplate: 'https://t.example/trace/{traceId}' })
          : Promise.resolve({ taskId: 't1', status: 'succeeded', output: 'hi back', traceId: TRACE }))
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    const link = await screen.findByRole('link', { name: /View trace/ }, { timeout: 8000 })
    expect(link).toHaveAttribute('href', `https://t.example/trace/${TRACE}`)
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  }, 15000)

  it('shows no trace link without a configured template', async () => {
    resetConfigCache()
    apiGet.mockImplementation((url: string) =>
      url === '/api/chat/knights' ? Promise.resolve({ knights: [{ name: 'galahad' }] })
        : url === '/api/config' ? Promise.resolve({})
          : Promise.resolve({ taskId: 't1', status: 'succeeded', output: 'hi back', traceId: TRACE }))
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText('hi back', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /View trace/ })).toBeNull()
  }, 15000)

  it('sends a message, shows the pending turn, then the answer', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hello <b>there</b>')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(apiPost).toHaveBeenCalledWith('/api/chat/galahad', { message: 'hello <b>there</b>' }, { headers: { 'Idempotency-Key': expect.any(String) } })
    expect(await screen.findByRole('status')).toHaveTextContent('galahad is working')
    // Message is rendered as inert text, not HTML.
    expect(screen.getByText('hello <b>there</b>')).toBeInTheDocument()
    expect(await screen.findByText('run-1')).toBeInTheDocument()

    taskStatus = { taskId: 't1', status: 'succeeded', output: 'hi back', model: 'opus', cost: 0.5, toolCalls: 3 }
    expect(await screen.findByText('hi back', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('Model opus')).toBeInTheDocument()
    expect(screen.getByText('$0.50')).toBeInTheDocument()
    expect(screen.getByText('3 tool calls')).toBeInTheDocument()
  })

  it('shows the usage the gateway sends: cost, tokens, turns, tool calls and duration', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    taskStatus = {
      taskId: 't1', status: 'succeeded', output: 'done', model: 'opus', cost: 0.42, billing: 'api',
      tokens: { input: 1200, output: 300 }, turns: 3, toolCalls: 2, durationMs: 8200,
    }
    expect(await screen.findByText('done', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('$0.42')).toBeInTheDocument()
    expect(screen.queryByText('notional')).toBeNull()
    expect(screen.getByText('1.2k in / 300 out')).toBeInTheDocument()
    expect(screen.getByText('3 turns')).toBeInTheDocument()
    expect(screen.getByText('2 tool calls')).toBeInTheDocument()
    expect(screen.getByText(/tool calls/i)).toBeInTheDocument()
    expect(screen.getByText('8.2s')).toBeInTheDocument()
  })

  it('marks the cost of a subscription-billed reply as notional', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    taskStatus = { taskId: 't1', status: 'succeeded', output: 'sub', cost: 0.3, billing: 'subscription' }
    expect(await screen.findByText('sub', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('$0.30')).toBeInTheDocument()
    expect(screen.getByText('notional')).toBeInTheDocument()
    expect(screen.queryByText(/tool calls/i)).toBeNull()
  })

  it('shows no usage labels when the reply carries none', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    taskStatus = { taskId: 't1', status: 'succeeded', output: 'bare' }
    expect(await screen.findByText('bare', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.queryByText(/\$0\.00|undefined|tool calls|turns?$|notional/)).toBeNull()
  })

  it('flags a reply that hit the usage limit', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    taskStatus = { taskId: 't1', status: 'failed', error: 'stopped', usageLimited: true }
    expect(await screen.findByText('Usage limit reached', {}, { timeout: 4000 })).toBeInTheDocument()
  })

  it('stops polling and fails the turn when the task is gone (404)', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hi')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    apiGet.mockImplementation((url: string) =>
      url === '/api/chat/knights' ? Promise.resolve({ knights: [] }) : Promise.reject(new ApiError(404, 'not found')))
    expect(await screen.findByText('Task not found on the gateway', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
  })

  it('continues the conversation with the runId from the URL', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad&run=run-9']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'again')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(apiPost).toHaveBeenCalledWith('/api/chat/galahad', { message: 'again', runId: 'run-9' }, expect.anything())
  })

  it('shows a failed turn and send errors', async () => {
    apiPost.mockRejectedValueOnce(new Error('Gateway not configured (set GATEWAY_URL)'))
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'x')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/Gateway not configured/)).toBeInTheDocument()
  })

  it('keeps the key when a failed send is retried', async () => {
    apiPost.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'x')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/boom/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
    const keys = apiPost.mock.calls.map((c) => c[2].headers['Idempotency-Key'])
    expect(keys[1]).toBe(keys[0])
  })

  it('opens the activity panel for a turn', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'x')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    await act(async () => {})
    await userEvent.click(await screen.findByRole('button', { name: /activity/i }))
    expect(screen.getByTestId('activity')).toHaveTextContent('t1')
  })

  it('sends the knight namespace and labels same-named knights by namespace', async () => {
    apiGet.mockImplementation((url: string) =>
      Promise.resolve(url === '/api/chat/knights'
        ? { knights: [{ name: 'galahad', namespace: 'a' }, { name: 'galahad', namespace: 'b' }, { name: 'rt-ui', namespace: 'a' }] }
        : taskStatus))
    render(<MemoryRouter initialEntries={['/chat']}><ChatPage /></MemoryRouter>)
    expect(await screen.findByRole('option', { name: 'a/galahad' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'b/galahad' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'rt-ui' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'b/galahad')
    await userEvent.type(await screen.findByLabelText('Message'), 'hi')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(apiPost).toHaveBeenCalledWith('/api/chat/galahad', { message: 'hi', namespace: 'b' }, { headers: { 'Idempotency-Key': expect.any(String) } })
  })

  it('lists knights from the gateway', async () => {
    render(<MemoryRouter initialEntries={['/chat']}><ChatPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('option', { name: 'galahad' })).toBeInTheDocument())
    expect(screen.getByRole('option', { name: 'rt-ui' })).toBeInTheDocument()
  })
})

describe('ChatPage selection, races and stale turns', () => {
  const knightsResp = (list: unknown[]) => apiGet.mockImplementation((url: string) =>
    Promise.resolve(url === '/api/chat/knights' ? { knights: list } : taskStatus))

  it('preselects the only knight with that name when ns is missing', async () => {
    knightsResp([{ name: 'alice', namespace: 'team-a' }, { name: 'bob', namespace: 'team-a' }])
    render(<MemoryRouter initialEntries={['/chat?knight=alice']}><ChatPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Knight')).toHaveValue('team-a/alice'))
    await userEvent.type(await screen.findByLabelText('Message'), 'hi')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(apiPost).toHaveBeenCalledWith('/api/chat/alice', { message: 'hi', namespace: 'team-a' }, expect.anything())
  })

  it('does not guess when several knights share the name', async () => {
    knightsResp([{ name: 'alice', namespace: 'a' }, { name: 'alice', namespace: 'b' }])
    render(<MemoryRouter initialEntries={['/chat?knight=alice']}><ChatPage /></MemoryRouter>)
    expect(await screen.findByRole('option', { name: 'Pick the namespace' })).toBeInTheDocument()
    expect(screen.getByLabelText('Knight')).toHaveValue('')
  })

  it('ignores a send that resolves after the knight was switched', async () => {
    let resolve!: (v: unknown) => void
    apiPost.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hi')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'rt-ui')
    await act(async () => { resolve({ taskId: 't9', runId: 'old-run', status: 'pending' }) })
    expect(screen.queryAllByTestId('chat-turn')).toHaveLength(0)
    expect(screen.queryByText('old-run')).not.toBeInTheDocument()
  })

  it('shows a stale notice and re-enables Send after two minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await user.type(await screen.findByLabelText('Message'), 'hi')
    await user.click(screen.getByRole('button', { name: /send/i }))
    await screen.findByRole('status')
    await user.type(screen.getByLabelText('Message'), 'again')
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
    expect(screen.queryByText(/Still waiting/)).not.toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(STALE_TURN_MS + 1000) })
    expect(screen.getByText(/Still waiting/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /failed & lost/i })).toHaveAttribute('href', '/failed')
    expect(screen.getByRole('button', { name: /send/i })).toBeEnabled()
  })

  it('clears the stale timer when the turn finishes early', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await user.type(await screen.findByLabelText('Message'), 'hi')
    await user.click(screen.getByRole('button', { name: /send/i }))
    await screen.findByRole('status')
    const before = vi.getTimerCount()
    taskStatus = { taskId: 't1', status: 'succeeded', output: 'done' }
    await act(async () => { vi.advanceTimersByTime(5000) })
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(vi.getTimerCount()).toBeLessThan(before)
    await act(async () => { vi.advanceTimersByTime(STALE_TURN_MS + 1000) })
    expect(screen.queryByText(/Still waiting/)).not.toBeInTheDocument()
  })

  it('retries the knights fetch', async () => {
    apiGet.mockRejectedValueOnce(new Error('down'))
    render(<MemoryRouter initialEntries={['/chat']}><ChatPage /></MemoryRouter>)
    expect(await screen.findByText(/down/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByRole('option', { name: 'galahad' })).toBeInTheDocument()
  })
})

describe('parseKnightNames', () => {
  it('accepts arrays, wrapped lists and strings', () => {
    expect(parseKnights(['b', 'a'])).toEqual([{ name: 'a' }, { name: 'b' }])
    expect(parseKnights({ knights: [{ name: 'x' }, { name: 'x' }, {}] })).toEqual([{ name: 'x' }])
    expect(parseKnights(null)).toEqual([])
    expect(parseKnights([{ name: 'x', namespace: 'b' }, { name: 'x', namespace: 'a' }])).toEqual([
      { name: 'x', namespace: 'a' }, { name: 'x', namespace: 'b' },
    ])
  })
})
