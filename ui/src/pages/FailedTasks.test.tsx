import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
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

function renderPage(url = '/failed') {
  return render(<MemoryRouter initialEntries={[url]}><FailedTasksPage /></MemoryRouter>)
}

beforeEach(() => {
  apiGet.mockReset()
  apiPost.mockReset()
  apiGet.mockResolvedValue({ deadLetters: letters })
})

describe('FailedTasksPage', () => {
  it('lists the dead letters', async () => {
    renderPage()
    expect(await screen.findAllByTestId('dead-letter-row')).toHaveLength(2)
    expect(apiGet).toHaveBeenCalledWith('/api/dead-letters')
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
})
