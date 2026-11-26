import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DeadLettersView } from './DeadLettersView'
import type { DeadLetter, RetryResult } from '../lib/deadLetters'

const lost: DeadLetter = {
  taskId: 't1', knight: 'galahad', state: 'open', reason: 'lost', attempt: 1,
  updatedAt: '2026-11-24T10:00:00Z', error: 'delivered 5 times', task: { task: 'scan it' },
}
const chain: DeadLetter = { ...lost, taskId: 't2', knight: 'rt-ui', reason: 'failed', chainName: 'pipe', stepName: 'build', error: 'boom' }
const resolved: DeadLetter = { ...lost, taskId: 't3', state: 'resolved' }
const result: RetryResult = { taskId: 't1-r2', retryOf: 't1', attempt: 2, knight: 'galahad' }

function setup(entries: DeadLetter[], onRetry = vi.fn().mockResolvedValue(result)) {
  const onLoadDetail = vi.fn((e: DeadLetter) => Promise.resolve(e))
  render(<MemoryRouter><DeadLettersView entries={entries} onRetry={onRetry} onLoadDetail={onLoadDetail} /></MemoryRouter>)
  return { onRetry, onLoadDetail }
}

describe('DeadLettersView', () => {
  it('shows an empty state', () => {
    setup([])
    expect(screen.getByText('No failed or lost tasks')).toBeInTheDocument()
  })

  it('lists entries and filters by knight and reason', async () => {
    setup([lost, chain])
    expect(screen.getAllByTestId('dead-letter-row')).toHaveLength(2)
    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'rt-ui')
    expect(screen.getAllByTestId('dead-letter-row')).toHaveLength(1)
    await userEvent.selectOptions(screen.getByLabelText('Knight'), '')
    await userEvent.selectOptions(screen.getByLabelText('Reason'), 'lost')
    expect(screen.getAllByTestId('dead-letter-row')[0].textContent).toContain('galahad')
  })

  it('retries an open entry once, disabled while pending, then links the new task', async () => {
    let resolve!: (r: RetryResult) => void
    const onRetry = vi.fn(() => new Promise<RetryResult>((r) => { resolve = r }))
    setup([lost], onRetry)
    const btn = screen.getByRole('button', { name: /Retry/ })
    await userEvent.click(btn)
    expect(btn).toBeDisabled()
    await userEvent.click(btn)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(lost, false)
    resolve(result)
    const link = await screen.findByRole('link', { name: /t1-r2/ })
    expect(link).toHaveAttribute('href', '/running?task=t1-r2')
  })

  it('closes the retry confirmation on Escape without retrying', async () => {
    const { onRetry } = setup([chain])
    await userEvent.click(screen.getByRole('button', { name: 'Retry outside the chain' }))
    expect(screen.getByRole('dialog', { name: 'Retry outside the chain?' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('asks for confirmation before retrying a chain step outside the chain, with force', async () => {
    const { onRetry } = setup([chain])
    await userEvent.click(screen.getByRole('button', { name: 'Retry outside the chain' }))
    expect(onRetry).not.toHaveBeenCalled()
    const dialog = screen.getByText('Retry outside the chain?').closest('div')!.parentElement!
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry outside the chain' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(chain, true)
  })

  it('greys resolved entries with a note and no Retry button', () => {
    setup([resolved])
    expect(screen.getByTestId('dead-letter-row').className).toContain('opacity-50')
    expect(screen.getByText('A later success arrived')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull()
  })

  it('shows the full error and original task in the drawer', async () => {
    const { onLoadDetail } = setup([lost])
    await userEvent.click(screen.getByTestId('dead-letter-row'))
    expect(onLoadDetail).toHaveBeenCalledWith(lost)
    await waitFor(() => expect(screen.getByText('scan it')).toBeInTheDocument())
    expect(within(screen.getByRole('dialog')).getByText('delivered 5 times')).toBeInTheDocument()
  })

  it('shows a retry error', async () => {
    setup([lost], vi.fn().mockRejectedValue(new Error('dead letter t1 is retried')))
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('dead letter t1 is retried')
  })
})
