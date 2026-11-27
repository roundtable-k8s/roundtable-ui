import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { FailedTasksPage } from './FailedTasks'
import type { DeadLetter } from '../lib/deadLetters'

const apiGet = vi.fn()
const apiPost = vi.fn()
vi.mock('../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
}))

function dl(over: Partial<DeadLetter>): DeadLetter {
  return { taskId: 't1', knight: 'galahad', state: 'open', reason: 'timeout', attempt: 1, updatedAt: '2026-11-24T10:00:00Z', ...over }
}

const letters = [
  dl({ taskId: 't1', table: 'fleet-a', error: 'deadline exceeded' }),
  dl({ taskId: 't2', table: 'dev', knight: 'rt-ui', reason: 'no-consumer', error: 'nobody home' }),
]

function UrlProbe() {
  return <span data-testid="url-search">{useLocation().search}</span>
}

function renderPage(url = '/failed') {
  return render(<MemoryRouter initialEntries={[url]}><UrlProbe /><FailedTasksPage /></MemoryRouter>)
}

beforeEach(() => {
  apiGet.mockReset()
  apiPost.mockReset()
  apiGet.mockResolvedValue({ deadLetters: letters })
})

describe('FailedTasksPage', () => {
  it('keeps the state filter in the URL', async () => {
    renderPage('/failed?state=open')
    expect(await screen.findAllByTestId('dead-letter-row')).toHaveLength(2)
    expect(apiGet).toHaveBeenCalledWith('/api/dead-letters?state=open', expect.anything())
    expect(screen.getByLabelText('State')).toHaveValue('open')
    await userEvent.selectOptions(screen.getByLabelText('State'), 'resolved')
    expect(screen.getByTestId('url-search')).toHaveTextContent('?state=resolved')
    await userEvent.selectOptions(screen.getByLabelText('State'), 'all')
    expect(screen.getByTestId('url-search').textContent).toBe('')
  })

  it('falls back to all states for an unknown state in the URL', async () => {
    renderPage('/failed?state=bogus')
    expect(await screen.findAllByTestId('dead-letter-row')).toHaveLength(2)
    expect(screen.getByLabelText('State')).toHaveValue('all')
  })

  it('lists the dead letters', async () => {
    renderPage()
    expect(await screen.findAllByTestId('dead-letter-row')).toHaveLength(2)
    expect(apiGet).toHaveBeenCalledWith('/api/dead-letters', expect.anything())
    expect(screen.getByText('deadline exceeded')).toBeInTheDocument()
  })

  it('shows the empty state when there are none', async () => {
    apiGet.mockResolvedValue({})
    renderPage()
    expect(await screen.findByText('No failed or lost tasks')).toBeInTheDocument()
  })

  it('shows the load error', async () => {
    apiGet.mockRejectedValue(new Error('gateway unreachable'))
    renderPage()
    expect(await screen.findByText(/gateway unreachable/)).toBeInTheDocument()
  })

  it('narrows to the ?table= filter', async () => {
    renderPage('/failed?table=dev')
    const rows = await screen.findAllByTestId('dead-letter-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('rt-ui')
  })

  it('applies a ?table= switch made while a slow response is in flight', async () => {
    let resolveSlow!: (v: unknown) => void
    apiGet.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r }))
    function Switch() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/failed?table=dev')}>switch-table</button>
    }
    render(<MemoryRouter initialEntries={['/failed?table=fleet-a']}><Switch /><FailedTasksPage /></MemoryRouter>)
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByText('switch-table'))
    await act(async () => { resolveSlow({ deadLetters: letters }) })
    const rows = await screen.findAllByTestId('dead-letter-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('rt-ui')
    expect(screen.queryByText('deadline exceeded')).not.toBeInTheDocument()
  })

  it('filters by knight', async () => {
    renderPage()
    await screen.findAllByTestId('dead-letter-row')
    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'rt-ui')
    const rows = screen.getAllByTestId('dead-letter-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('nobody home')
  })

  it('retry posts to the gateway and reloads the list', async () => {
    apiPost.mockResolvedValue({ taskId: 'retry-t1', retryOf: 't1', attempt: 2, knight: 'galahad' })
    renderPage()
    await screen.findAllByTestId('dead-letter-row')
    expect(apiGet).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getAllByRole('button', { name: /^Retry$/ })[0])
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/dead-letters/t1/retry', { force: false, table: 'fleet-a' }))
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Retried as retry-t1')).toBeInTheDocument()
  })

  it('shows a retry failure and does not reload', async () => {
    apiPost.mockRejectedValue(new Error('already retried'))
    renderPage()
    await screen.findAllByTestId('dead-letter-row')
    await userEvent.click(screen.getAllByRole('button', { name: /^Retry$/ })[0])
    expect(await screen.findByText(/Retry failed: already retried/)).toBeInTheDocument()
    expect(apiGet).toHaveBeenCalledTimes(1)
  })

  it('ignores a slow response that a newer request superseded', async () => {
    let resolveA!: (v: unknown) => void
    apiGet.mockImplementationOnce(() => new Promise((r) => { resolveA = r }))
    apiGet.mockResolvedValueOnce({ deadLetters: letters })
    renderPage('/failed?table=fleet-a')
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1))
    // a second request (refresh) aborts the first; the first resolving late must not win
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }))
    const rows = await screen.findAllByTestId('dead-letter-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('galahad')
    await act(async () => { resolveA({ deadLetters: [dl({ taskId: 'old', table: 'fleet-a', knight: 'stale-knight' })] }) })
    expect(screen.queryByText('stale-knight')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('dead-letter-row')).toHaveLength(1)
  })

  it('shows the cap note when total exceeds the list', async () => {
    apiGet.mockResolvedValue({ deadLetters: letters, total: 250 })
    renderPage()
    expect(await screen.findByTestId('dead-letters-cap')).toHaveTextContent('Showing the newest 2 of 250')
  })

  it('shows the cap note for a full list without a total', async () => {
    apiGet.mockResolvedValue({ deadLetters: Array.from({ length: 100 }, (_, i) => dl({ taskId: `t${i}` })) })
    renderPage()
    expect(await screen.findByTestId('dead-letters-cap')).toHaveTextContent('Showing the newest 100')
  })

  it('shows no cap note when everything is listed', async () => {
    apiGet.mockResolvedValue({ deadLetters: letters, total: 2 })
    renderPage()
    await screen.findAllByTestId('dead-letter-row')
    expect(screen.queryByTestId('dead-letters-cap')).not.toBeInTheDocument()
  })

  it('keeps the rows when a refresh fails and clears the error on success', async () => {
    renderPage()
    await screen.findAllByTestId('dead-letter-row')
    apiGet.mockRejectedValueOnce(new Error('gateway down'))
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }))
    expect(await screen.findByText(/gateway down/)).toBeInTheDocument()
    expect(screen.getAllByTestId('dead-letter-row')).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: /refresh/i }))
    await waitFor(() => expect(screen.queryByText(/gateway down/)).not.toBeInTheDocument())
  })

  it('the state select passes ?state= to the gateway', async () => {
    renderPage()
    await screen.findAllByTestId('dead-letter-row')
    await userEvent.selectOptions(screen.getByLabelText('State'), 'open')
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/api/dead-letters?state=open', expect.anything()))
  })

  it('marks the rows stale while a response for another state is pending', async () => {
    renderPage()
    await screen.findAllByTestId('dead-letter-row')
    const box = screen.getByTestId('dead-letters-rows')
    expect(box).toHaveAttribute('aria-busy', 'false')
    let resolveOpen!: (v: unknown) => void
    apiGet.mockImplementationOnce(() => new Promise((r) => { resolveOpen = r }))
    await userEvent.selectOptions(screen.getByLabelText('State'), 'open')
    await waitFor(() => expect(box).toHaveAttribute('aria-busy', 'true'))
    expect(box.className).toContain('opacity-50')
    await act(async () => { resolveOpen({ deadLetters: letters }) })
    expect(box).toHaveAttribute('aria-busy', 'false')
    expect(box.className).not.toContain('opacity-50')
  })
})
