import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BriefingsPage } from './Briefings'
import { ApiError } from '../lib/api'

const apiGet = vi.fn()
const apiGetText = vi.fn()
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiGetText: (...a: unknown[]) => apiGetText(...a),
}))

// Newest first; 2024-01-04 is missing (a weekend), so "older" from 01-05 must skip it.
const DATES = ['2024-01-05.md', '2024-01-02.md', '2024-01-01.md']
const entries = DATES.map((name) => ({ name, dir: 'Briefings/Daily' }))

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('BriefingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiGetText.mockReset()
    apiGetText.mockResolvedValue('# hi')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an error, not the empty state, when the list fails', async () => {
    apiGet.mockRejectedValue(new Error('HTTP 500'))
    render(<BriefingsPage />)
    expect(await screen.findByText(/Failed to load briefings: HTTP 500/)).toBeInTheDocument()
    expect(screen.queryByText('No briefings yet')).not.toBeInTheDocument()
  })

  it('shows the empty state when the list is genuinely empty', async () => {
    apiGet.mockResolvedValue([])
    render(<BriefingsPage />)
    expect((await screen.findAllByText('No briefings yet')).length).toBeGreaterThan(0)
    expect(screen.queryByText(/Failed to load/)).not.toBeInTheDocument()
  })

  it('shows each entry directory in the list and the selected one in the header', async () => {
    apiGet.mockResolvedValue([
      { name: '2024-01-02.md', dir: 'Agents/Briefings' },
      { name: '2024-01-01.md', dir: 'Briefings/Daily' },
    ])
    render(<BriefingsPage />)
    const rows = await screen.findAllByRole('button', { name: /2024-01-0/ })
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('Agents/Briefings')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Briefings/Daily')).toBeInTheDocument()
    expect(await screen.findByTitle('Source directory')).toHaveTextContent('Agents/Briefings')
    await userEvent.click(rows[1])
    await waitFor(() => expect(screen.getByTitle('Source directory')).toHaveTextContent('Briefings/Daily'))
  })

  it('shows the last clicked briefing even when an earlier response arrives last', async () => {
    apiGet.mockResolvedValue(entries)
    const newest = deferred<string>()
    const clicked = deferred<string>()
    apiGetText.mockImplementation((url: string) =>
      url.includes('2024-01-05') ? newest.promise : clicked.promise,
    )
    render(<BriefingsPage />)
    // 01-05 is auto-selected and still pending; click 01-02 and let it answer first.
    await userEvent.click(await screen.findByRole('button', { name: /2024-01-02/ }))
    await act(async () => { clicked.resolve('Body of the 02 briefing') })
    expect(await screen.findByText('Body of the 02 briefing')).toBeInTheDocument()
    await act(async () => { newest.resolve('Body of the 05 briefing') })
    expect(screen.queryByText('Body of the 05 briefing')).not.toBeInTheDocument()
    expect(screen.getByText('Body of the 02 briefing')).toBeInTheDocument()
  })

  it('shows a retryable error for a server failure, not the not-found message', async () => {
    apiGet.mockResolvedValue([entries[0]])
    apiGetText
      .mockRejectedValueOnce(new ApiError(500, 'HTTP 500'))
      .mockResolvedValueOnce('Recovered body')
    render(<BriefingsPage />)
    expect(await screen.findByText(/Failed to load briefing: HTTP 500/)).toBeInTheDocument()
    expect(screen.queryByText('No briefing available for this date')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Recovered body')).toBeInTheDocument()
  })

  it('shows the not-found message only for a 404', async () => {
    apiGet.mockResolvedValue([entries[0]])
    apiGetText.mockRejectedValue(new ApiError(404, 'Briefing not found'))
    render(<BriefingsPage />)
    expect(await screen.findByText('No briefing available for this date')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('steps to the neighbouring briefing and disables the buttons at the ends', async () => {
    apiGet.mockResolvedValue(entries)
    render(<BriefingsPage />)
    const older = await screen.findByRole('button', { name: 'Older briefing' })
    const newer = screen.getByRole('button', { name: 'Newer briefing' })
    expect(newer).toBeDisabled()

    await userEvent.click(older)
    expect(await screen.findByRole('heading', { name: /January 2, 2024/ })).toBeInTheDocument()
    expect(apiGetText).toHaveBeenLastCalledWith('/api/briefings/2024-01-02?dir=Briefings%2FDaily', expect.anything())

    await userEvent.click(older)
    expect(await screen.findByRole('heading', { name: /January 1, 2024/ })).toBeInTheDocument()
    expect(older).toBeDisabled()

    await userEvent.click(newer)
    expect(await screen.findByRole('heading', { name: /January 2, 2024/ })).toBeInTheDocument()
  })

  it('refreshes the archive every minute and keeps the open briefing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiGet.mockResolvedValueOnce(entries.slice(1)).mockResolvedValue(entries)
    render(<BriefingsPage />)
    expect(await screen.findByRole('heading', { name: /January 2, 2024/ })).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

    expect(await screen.findByRole('button', { name: /2024-01-05/ })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /January 2, 2024/ })).toBeInTheDocument()
    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(apiGetText).toHaveBeenCalledTimes(1)
  })

  it('selects the nearest entry when a refresh drops the open one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiGet.mockResolvedValueOnce(entries).mockResolvedValue([entries[0], entries[2]])
    render(<BriefingsPage />)
    await userEvent.click(await screen.findByRole('button', { name: 'Older briefing' }))
    expect(await screen.findByRole('heading', { name: /January 2, 2024/ })).toBeInTheDocument()

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

    expect(await screen.findByRole('heading', { name: /January 1, 2024/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Newer briefing' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Older briefing' })).toBeDisabled()
  })
})
