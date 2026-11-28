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

// The first poll wait is jittered +-10 % (#628); pin it so one interval is exactly one tick.
let random: ReturnType<typeof vi.spyOn>
beforeEach(() => { vi.useFakeTimers(); random = vi.spyOn(Math, 'random').mockReturnValue(0.5); apiGet.mockReset(); apiPost.mockReset() })
afterEach(() => { vi.useRealTimers(); random.mockRestore() })

describe('RunNow', () => {
  it('starts a run with the namespace and no input when blank', async () => {
    apiPost.mockResolvedValue({ run: 'scan-abc', namespace: 'ns1', phase: 'Running' })
    renderIt()
    await click()
    expect(apiPost).toHaveBeenCalledWith('/api/chains/nightly%20scan/run', { namespace: 'ns1' }, { headers: { 'Idempotency-Key': expect.any(String) } })
    expect(screen.getByText('scan-abc')).toHaveAttribute('href', '/chains?chain=scan-abc')
    expect(screen.getByTestId('run-phase')).toHaveTextContent('Running')
  })

  it('sends the typed input', async () => {
    apiPost.mockResolvedValue({ run: 'r1', namespace: 'ns1' })
    renderIt()
    fireEvent.change(screen.getByLabelText('Input for nightly scan'), { target: { value: 'hello' } })
    await click()
    expect(apiPost).toHaveBeenCalledWith(expect.any(String), { namespace: 'ns1', input: 'hello' }, expect.anything())
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

  it('reuses the key for a retry after a 5xx and uses a new one after success', async () => {
    apiPost.mockRejectedValueOnce(Object.assign(new Error('bad gateway'), { status: 502 }))
      .mockResolvedValue({ run: 'r1', namespace: 'ns1' })
    renderIt()
    await click()
    await click()
    await click()
    const keys = apiPost.mock.calls.map((c) => c[2].headers['Idempotency-Key'])
    expect(keys).toHaveLength(3)
    expect(keys[1]).toBe(keys[0])
    expect(keys[2]).not.toBe(keys[0])
  })

  it('sends no second request while one is in flight', async () => {
    apiPost.mockReturnValue(new Promise(() => {}))
    renderIt()
    const btn = screen.getByRole('button', { name: /Run now/ })
    await act(async () => { fireEvent.click(btn) })
    expect(btn).toBeDisabled()
    await act(async () => { fireEvent.click(btn) })
    expect(apiPost).toHaveBeenCalledTimes(1)
  })
})
