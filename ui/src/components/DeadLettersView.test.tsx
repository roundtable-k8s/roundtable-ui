import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DeadLettersView } from './DeadLettersView'
import { ApiError, apiGet } from '../lib/api'
import { resetConfigCache } from '../hooks/useConfig'
import type { DeadLetter, RetryResult } from '../lib/deadLetters'

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiGet: vi.fn(() => Promise.resolve({})),
}))

const lost: DeadLetter = {
  taskId: 't1', knight: 'galahad', state: 'open', reason: 'lost', attempt: 1,
  updatedAt: '2026-11-24T10:00:00Z', error: 'delivered 5 times', task: { task: 'scan it' },
}
const chain: DeadLetter = { ...lost, taskId: 't2', knight: 'rt-ui', reason: 'failed', chainName: 'pipe', stepName: 'build', error: 'boom' }
const resolved: DeadLetter = { ...lost, taskId: 't3', state: 'resolved' }
const result: RetryResult = { taskId: 't1-r2', retryOf: 't1', attempt: 2, knight: 'galahad' }

/** Loader for GET /api/dead-letters/{taskId}: known ids resolve, others 404. */
function loaderFrom(map: Record<string, DeadLetter>) {
  return vi.fn((taskId: string) => (map[taskId]
    ? Promise.resolve(map[taskId])
    : Promise.reject(new ApiError(404, 'not found'))))
}

function setup(entries: DeadLetter[], onRetry = vi.fn().mockResolvedValue(result), onLoadEntry = loaderFrom({})) {
  const onLoadDetail = vi.fn((e: DeadLetter) => Promise.resolve(e))
  render(<MemoryRouter><DeadLettersView entries={entries} onRetry={onRetry} onLoadDetail={onLoadDetail} onLoadEntry={onLoadEntry} /></MemoryRouter>)
  return { onRetry, onLoadDetail, onLoadEntry }
}

describe('DeadLettersView', () => {
  it('keeps the rows visible under an error', () => {
    render(<MemoryRouter><DeadLettersView entries={[lost]} error="refresh failed" onRetry={vi.fn()} onLoadDetail={vi.fn()} onLoadEntry={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText('refresh failed')).toBeInTheDocument()
    expect(screen.getAllByTestId('dead-letter-row')).toHaveLength(1)
  })

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

  it('opens the drawer from the keyboard with Enter on a row', async () => {
    setup([lost])
    screen.getByTestId('dead-letter-row').focus()
    await userEvent.keyboard('{Enter}')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
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

  it('sanitises the retry banner text (ANSI, control character, bidi override)', async () => {
    setup([lost], vi.fn().mockRejectedValue(new Error('dead letter \u001b[31mt1\u0007\u202e is retried')))
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Retry failed: dead letter t1 is retried')
    expect(alert.textContent).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e\u001b]/)
  })

  describe('earlier attempts', () => {
    const attempt1: DeadLetter = { ...lost, taskId: 'a1', attempt: 1, reason: 'timeout', error: 'timed out after 30m\nmore detail' }
    const attempt2: DeadLetter = { ...lost, taskId: 'a2', attempt: 2, reason: 'failed', error: 'usage limit reached', retryOf: 'a1' }

    it('shows the reason and first error line of the earlier attempt', async () => {
      const onLoadEntry = loaderFrom({ a1: attempt1 })
      setup([attempt2], undefined, onLoadEntry)
      await userEvent.click(screen.getByTestId('dead-letter-row'))
      const section = await screen.findByTestId('earlier-attempts')
      expect(section).toHaveTextContent('Attempt 1:')
      expect(section).toHaveTextContent('timeout')
      expect(section).toHaveTextContent('timed out after 30m')
      expect(section).not.toHaveTextContent('more detail')
      expect(onLoadEntry).toHaveBeenCalledTimes(1)
      expect(onLoadEntry).toHaveBeenCalledWith('a1', undefined, expect.any(AbortSignal))
    })

    it('makes no extra request for an entry without retryOf', async () => {
      const onLoadEntry = loaderFrom({})
      setup([lost], undefined, onLoadEntry)
      await userEvent.click(screen.getByTestId('dead-letter-row'))
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(onLoadEntry).not.toHaveBeenCalled()
      expect(screen.queryByTestId('earlier-attempts')).toBeNull()
    })

    it('shows nothing and no error when the earlier entry is gone (404)', async () => {
      const onLoadEntry = loaderFrom({})
      setup([attempt2], undefined, onLoadEntry)
      await userEvent.click(screen.getByTestId('dead-letter-row'))
      await waitFor(() => expect(onLoadEntry).toHaveBeenCalledWith('a1', undefined, expect.any(AbortSignal)))
      // Wait for the 404 to settle before asserting absence, so the assertion cannot pass early.
      await expect(onLoadEntry.mock.results[0].value).rejects.toBeInstanceOf(ApiError)
      expect(screen.queryByTestId('earlier-attempts')).toBeNull()
      expect(screen.queryByText(/could not be loaded/)).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('shows a non-404 load failure as sanitised text', async () => {
      const onLoadEntry = vi.fn(() => Promise.reject(new Error('gateway \u001b[31mdown\u0007\u202e now')))
      setup([attempt2], undefined, onLoadEntry)
      await userEvent.click(screen.getByTestId('dead-letter-row'))
      const note = await screen.findByText(/could not be loaded/)
      expect(note).toHaveTextContent('Earlier attempts could not be loaded: gateway down now')
      expect(note.textContent).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e\u001b]/)
    })

    it('aborts the in-flight earlier-attempt request when the view unmounts', async () => {
      const signals: AbortSignal[] = []
      const onLoadEntry = vi.fn((_taskId: string, _table?: string, signal?: AbortSignal) => {
        signals.push(signal!)
        return new Promise<DeadLetter>(() => {})
      })
      const { unmount } = render(<MemoryRouter><DeadLettersView entries={[attempt2]} onRetry={vi.fn()} onLoadDetail={(e) => Promise.resolve(e)} onLoadEntry={onLoadEntry} /></MemoryRouter>)
      await userEvent.click(screen.getByTestId('dead-letter-row'))
      await waitFor(() => expect(signals).toHaveLength(1))
      expect(signals[0].aborted).toBe(false)
      unmount()
      expect(signals[0].aborted).toBe(true)
    })

    it('follows the chain at most three steps back, oldest first', async () => {
      const b = (n: number, retryOf?: string): DeadLetter => ({ ...lost, taskId: `b${n}`, attempt: n, reason: `r${n}`, error: `e${n}`, retryOf })
      const top = b(5, 'b4')
      const onLoadEntry = loaderFrom({ b4: b(4, 'b3'), b3: b(3, 'b2'), b2: b(2, 'b1'), b1: b(1) })
      setup([top], undefined, onLoadEntry)
      await userEvent.click(screen.getByTestId('dead-letter-row'))
      const section = await screen.findByTestId('earlier-attempts')
      expect(onLoadEntry).toHaveBeenCalledTimes(3)
      const text = section.textContent ?? ''
      expect(text).not.toContain('Attempt 1:')
      expect(text.indexOf('Attempt 2:')).toBeLessThan(text.indexOf('Attempt 3:'))
      expect(text.indexOf('Attempt 3:')).toBeLessThan(text.indexOf('Attempt 4:'))
    })
  })

  describe('bulk retry', () => {
    const o = (n: number, extra: Partial<DeadLetter> = {}): DeadLetter => ({ ...lost, taskId: `o${n}`, ...extra })
    const res = (id: string): RetryResult => ({ taskId: `${id}-r2`, retryOf: id, attempt: 2, knight: 'galahad' })

    it('does not offer chain-owned or non-open rows for selection', () => {
      setup([lost, chain, resolved])
      expect(screen.getByLabelText('Select t1')).toBeInTheDocument()
      expect(screen.queryByLabelText('Select t2')).toBeNull()
      expect(screen.queryByLabelText('Select t3')).toBeNull()
    })

    it('select all respects the filters', async () => {
      setup([o(1), o(2), o(3, { knight: 'rt-ui' })])
      await userEvent.selectOptions(screen.getByLabelText('Knight'), 'galahad')
      await userEvent.click(screen.getByLabelText('Select all shown'))
      expect(screen.getByRole('button', { name: 'Retry 2 selected' })).toBeInTheDocument()
      await userEvent.selectOptions(screen.getByLabelText('Knight'), '')
      expect(screen.getByRole('button', { name: 'Retry 2 selected' })).toBeInTheDocument()
      expect(screen.getByLabelText('Select o3')).not.toBeChecked()
    })

    it('retries in order after confirmation, survives a failure and shows results per row', async () => {
      const calls: string[] = []
      const onRetry = vi.fn(async (e: DeadLetter) => {
        calls.push(e.taskId)
        if (e.taskId === 'o2') throw new ApiError(409, 'already retried')
        return res(e.taskId)
      })
      setup([o(1), o(2), o(3)], onRetry)
      await userEvent.click(screen.getByLabelText('Select all shown'))
      await userEvent.click(screen.getByRole('button', { name: 'Retry 3 selected' }))
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toContain('3 tasks')
      expect(dialog.textContent).toContain('galahad')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Retry 3' }))
      await waitFor(() => expect(screen.getByTestId('bulk-summary').textContent).toBe('Retried 2, failed 1'))
      expect(calls).toEqual(['o1', 'o2', 'o3'])
      expect(onRetry).toHaveBeenCalledWith(expect.anything(), false)
      expect(screen.getByText('Retried as o1-r2')).toBeInTheDocument()
      expect(screen.getByText('Retried as o3-r2')).toBeInTheDocument()
      expect(screen.getByText(/Retry failed: already retried/)).toBeInTheDocument()
    })

    it('a successful single-row retry clears that row stale bulk error', async () => {
      let failO2 = true
      const onRetry = vi.fn(async (e: DeadLetter) => {
        if (e.taskId === 'o2' && failO2) { failO2 = false; throw new ApiError(409, 'already retried') }
        return res(e.taskId)
      })
      setup([o(1), o(2)], onRetry)
      await userEvent.click(screen.getByLabelText('Select all shown'))
      await userEvent.click(screen.getByRole('button', { name: 'Retry 2 selected' }))
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry 2' }))
      await waitFor(() => expect(screen.getByTestId('bulk-summary').textContent).toBe('Retried 1, failed 1'))
      const row = screen.getByLabelText('Select o2').closest('tr') as HTMLElement
      expect(within(row).getByRole('alert')).toHaveTextContent('Retry failed: already retried')
      await userEvent.click(within(row).getByRole('button', { name: 'Retry' }))
      expect(await screen.findByText('Retried as o2-r2')).toBeInTheDocument()
      expect(screen.queryByText(/Retry failed: already retried/)).toBeNull()
    })

    it('stops adding retries when the view unmounts', async () => {
      let release!: () => void
      const onRetry = vi.fn((e: DeadLetter) => new Promise<RetryResult>((r) => { release = () => r(res(e.taskId)) }))
      const onLoadDetail = vi.fn()
      const { unmount } = render(<MemoryRouter><DeadLettersView entries={[o(1), o(2)]} onRetry={onRetry} onLoadDetail={onLoadDetail} onLoadEntry={vi.fn()} /></MemoryRouter>)
      await userEvent.click(screen.getByLabelText('Select all shown'))
      await userEvent.click(screen.getByRole('button', { name: 'Retry 2 selected' }))
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retry 2' }))
      await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1))
      unmount()
      release()
      await new Promise((r) => setTimeout(r, 20))
      expect(onRetry).toHaveBeenCalledTimes(1)
    })
  })
})

describe('DeadLettersView races and errors', () => {
  it('shows no empty state when the load failed with no entries', () => {
    render(<MemoryRouter><DeadLettersView entries={[]} error="Failed to fetch" onRetry={vi.fn()} onLoadDetail={vi.fn()} onLoadEntry={vi.fn()} /></MemoryRouter>)
    expect(screen.getByText('Failed to fetch')).toBeInTheDocument()
    expect(screen.queryByText('No failed or lost tasks')).toBeNull()
  })

  it('shows all rows when a refresh drops the selected knight', async () => {
    const props = { onRetry: vi.fn(), onLoadDetail: vi.fn(), onLoadEntry: vi.fn() }
    const { rerender } = render(<MemoryRouter><DeadLettersView entries={[lost, chain]} {...props} /></MemoryRouter>)
    await userEvent.selectOptions(screen.getByLabelText('Knight'), 'rt-ui')
    expect(screen.getAllByTestId('dead-letter-row')).toHaveLength(1)
    rerender(<MemoryRouter><DeadLettersView entries={[lost]} {...props} /></MemoryRouter>)
    expect(screen.getAllByTestId('dead-letter-row')).toHaveLength(1)
    expect(screen.getByLabelText('Knight')).toHaveValue('')
  })

  it('keeps the detail of the last clicked row when answers arrive out of order', async () => {
    const other: DeadLetter = { ...chain, error: 'B error text' }
    const resolvers: Record<string, (d: DeadLetter) => void> = {}
    const onLoadDetail = vi.fn((e: DeadLetter) => new Promise<DeadLetter>((r) => { resolvers[e.taskId] = r }))
    render(<MemoryRouter><DeadLettersView entries={[lost, other]} onRetry={vi.fn()} onLoadDetail={onLoadDetail} onLoadEntry={loaderFrom({})} /></MemoryRouter>)
    const rows = screen.getAllByTestId('dead-letter-row')
    await userEvent.click(rows[0])
    await userEvent.click(rows[1])
    resolvers['t2'](other)
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByText('B error text')).toBeInTheDocument())
    resolvers['t1'](lost)
    await new Promise((r) => setTimeout(r, 10))
    expect(within(screen.getByRole('dialog')).getByText('B error text')).toBeInTheDocument()
    expect(within(screen.getByRole('dialog')).queryByText('delivered 5 times')).toBeNull()
  })
})

describe('DeadLettersView trace link', () => {
  const traceId = '0af7651916cd43dd8448eb211c80319c'

  it('shows View trace in the drawer of an entry with a trace ID when a viewer is configured', async () => {
    resetConfigCache()
    vi.mocked(apiGet).mockResolvedValue({ traceUrlTemplate: 'https://t.example/trace/{traceId}' })
    setup([{ ...lost, traceId }])
    await userEvent.click(screen.getAllByTestId('dead-letter-row')[0])
    await screen.findByText('Original task')
    const link = await screen.findByRole('link', { name: /View trace/ })
    expect(link).toHaveAttribute('href', `https://t.example/trace/${traceId}`)
  })

  it('shows no trace link for an entry without a trace ID', async () => {
    resetConfigCache()
    vi.mocked(apiGet).mockResolvedValue({ traceUrlTemplate: 'https://t.example/trace/{traceId}' })
    setup([lost])
    await userEvent.click(screen.getAllByTestId('dead-letter-row')[0])
    await screen.findByText('Original task')
    await waitFor(() => expect(apiGet).toHaveBeenCalled())
    expect(screen.queryByRole('link', { name: /View trace/ })).toBeNull()
  })
})
