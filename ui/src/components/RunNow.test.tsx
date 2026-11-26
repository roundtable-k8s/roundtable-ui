import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { RunNow } from './RunNow'

const apiGet = vi.fn()
const apiPost = vi.fn()
vi.mock('../lib/api', () => ({
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
}))

const renderIt = () => render(<MemoryRouter><RunNow chain="nightly scan" namespace="ns1" /></MemoryRouter>)
const click = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Run now/ })) }) }

beforeEach(() => { vi.useFakeTimers(); apiGet.mockReset(); apiPost.mockReset() })
afterEach(() => { vi.useRealTimers() })

describe('RunNow', () => {
  it('starts a run with the namespace and no input when blank', async () => {
    apiPost.mockResolvedValue({ run: 'scan-abc', namespace: 'ns1', phase: 'Running' })
    renderIt()
    await click()
    expect(apiPost).toHaveBeenCalledWith('/api/chains/nightly%20scan/run', { namespace: 'ns1' })
    expect(screen.getByText('scan-abc')).toHaveAttribute('href', '/chains?chain=scan-abc')
    expect(screen.getByTestId('run-phase')).toHaveTextContent('Running')
  })

  it('sends the typed input', async () => {
    apiPost.mockResolvedValue({ run: 'r1', namespace: 'ns1' })
    renderIt()
    fireEvent.change(screen.getByLabelText('Input for nightly scan'), { target: { value: 'hello' } })
    await click()
    expect(apiPost).toHaveBeenCalledWith(expect.any(String), { namespace: 'ns1', input: 'hello' })
  })

  it('polls the run until it is done, then stops', async () => {
    apiPost.mockResolvedValue({ run: 'r1', namespace: 'ns2', phase: 'Running' })
    apiGet.mockResolvedValueOnce({ run: 'r1', namespace: 'ns2', phase: 'Running' })
      .mockResolvedValue({ run: 'r1', namespace: 'ns2', phase: 'Succeeded', done: true })
    renderIt()
    await click()
    expect(apiGet).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(apiGet).toHaveBeenCalledWith('/api/chains/runs/ns2/r1', { signal: expect.any(AbortSignal) })
    expect(screen.getByTestId('run-phase')).toHaveTextContent('Running')

    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByTestId('run-phase')).toHaveTextContent('Succeeded')

    const calls = apiGet.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(apiGet).toHaveBeenCalledTimes(calls)
  })

  it('shows the error when the run cannot be started', async () => {
    apiPost.mockRejectedValue(new Error('chain is not invokable'))
    renderIt()
    await click()
    expect(screen.getByRole('alert')).toHaveTextContent('chain is not invokable')
    expect(screen.queryByTestId('run-phase')).toBeNull()
    expect(screen.getByRole('button', { name: 'Run now' })).toBeEnabled()
  })
})
