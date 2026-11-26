import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ChatPage } from './Chat'
import { parseKnights } from '../lib/chat'
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
  it('sends a message, shows the pending turn, then the answer', async () => {
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'hello <b>there</b>')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))

    expect(apiPost).toHaveBeenCalledWith('/api/chat/galahad', { message: 'hello <b>there</b>' })
    expect(await screen.findByRole('status')).toHaveTextContent('galahad is working')
    // Message is rendered as inert text, not HTML.
    expect(screen.getByText('hello <b>there</b>')).toBeInTheDocument()
    expect(await screen.findByText('run-1')).toBeInTheDocument()

    taskStatus = { taskId: 't1', status: 'succeeded', output: 'hi back', model: 'opus', costUsd: 0.5, toolCalls: 3 }
    expect(await screen.findByText('hi back', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByText('Model opus')).toBeInTheDocument()
    expect(screen.getByText('$0.50')).toBeInTheDocument()
    expect(screen.getByText('3 tool calls')).toBeInTheDocument()
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
    expect(apiPost).toHaveBeenCalledWith('/api/chat/galahad', { message: 'again', runId: 'run-9' })
  })

  it('shows a failed turn and send errors', async () => {
    apiPost.mockRejectedValueOnce(new Error('Gateway not configured (set GATEWAY_URL)'))
    render(<MemoryRouter initialEntries={['/chat?knight=galahad']}><ChatPage /></MemoryRouter>)
    await userEvent.type(await screen.findByLabelText('Message'), 'x')
    await userEvent.click(screen.getByRole('button', { name: /send/i }))
    expect(await screen.findByText(/Gateway not configured/)).toBeInTheDocument()
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
    expect(apiPost).toHaveBeenCalledWith('/api/chat/galahad', { message: 'hi', namespace: 'b' })
  })

  it('lists knights from the gateway', async () => {
    render(<MemoryRouter initialEntries={['/chat']}><ChatPage /></MemoryRouter>)
    await waitFor(() => expect(screen.getByRole('option', { name: 'galahad' })).toBeInTheDocument())
    expect(screen.getByRole('option', { name: 'rt-ui' })).toBeInTheDocument()
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
