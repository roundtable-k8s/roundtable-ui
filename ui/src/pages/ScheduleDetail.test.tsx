import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ScheduleDetailPage } from './ScheduleDetail'
import { apiDelete, apiGet, apiGetText, apiPost } from '../lib/api'
import type { Schedule, ScheduleRun, ScheduleRunResult } from '../lib/schedules'

vi.mock('../lib/api', () => ({ apiGet: vi.fn(), apiGetText: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn() }))
const mockApiGet = vi.mocked(apiGet)
const mockApiGetText = vi.mocked(apiGetText)
const mockApiPost = vi.mocked(apiPost)
const mockApiDelete = vi.mocked(apiDelete)

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    name: 'morning-digest', namespace: 'roundtable', table: 'fleet-a',
    cron: '0 7 * * 1-5', timeZone: 'Europe/Berlin', description: 'at 07:00 on Monday to Friday',
    target: { kind: 'chain', summary: 'chain digest', chain: 'digest' },
    suspended: false, nextRunAt: '2099-01-01T06:00:00Z', lastRunAt: '2026-11-25T06:00:02Z',
    lastResult: { time: '2026-11-25T06:00:02Z', outcome: 'started', run: 'digest-1' },
    managedBy: 'api', ...over,
  }
}

// Deliberately out of order: the page must show newest first.
const runs: ScheduleRun[] = [
  { run: 'digest-0', time: '2026-11-23T07:00:00Z', outcome: 'failed', durationSeconds: 31, resultAvailable: true },
  { run: 'digest-2', time: '2026-11-25T07:00:00Z', outcome: 'succeeded', durationSeconds: 212.4, costUSD: '0.41', resultAvailable: true },
  { time: '2026-11-24T07:00:00Z', outcome: 'skipped', reason: 'missed schedule time', resultAvailable: false },
]

const result: ScheduleRunResult = {
  schedule: 'morning-digest', target: 'chain', run: 'digest-2', phase: 'Succeeded',
  output: '# Digest\n\n**All quiet** today.',
}

const YAML = 'apiVersion: ai.roundtable.io/v1alpha1\nkind: Trigger\nmetadata:\n  name: morning-digest\n'

function mockApi(s: Schedule) {
  mockApiGet.mockImplementation(async (url: string) => {
    if (url === '/api/schedules/roundtable/morning-digest') return s
    if (url.startsWith('/api/schedules/roundtable/morning-digest/runs?')) return { runs }
    if (url === '/api/schedules/roundtable/morning-digest/runs/digest-2') return result
    throw new Error(`unexpected ${url}`)
  })
  mockApiGetText.mockResolvedValue(YAML)
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/schedules/roundtable/morning-digest']}>
      <Routes>
        <Route path="/schedules/:namespace/:name" element={<ScheduleDetailPage />} />
        <Route path="/schedules" element={<div>schedules list</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockApiGet.mockReset()
  mockApiGetText.mockReset()
  mockApiPost.mockReset()
  mockApiDelete.mockReset()
})

describe('ScheduleDetailPage', () => {
  it('shows the summary and the run history newest first with outcome, duration and cost', async () => {
    mockApi(sched())
    renderPage()
    const summary = await screen.findByRole('region', { name: 'summary' })
    expect(summary).toHaveTextContent('chain digest')
    expect(summary).toHaveTextContent('at 07:00 on Monday to Friday')

    const history = await screen.findByRole('region', { name: 'run history' })
    expect(mockApiGet).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest/runs?limit=50')
    const rows = within(history).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Succeeded')
    expect(rows[0]).toHaveTextContent('3m 32s')
    expect(rows[0]).toHaveTextContent('$0.41')
    expect(rows[1]).toHaveTextContent('Skipped')
    expect(rows[1]).toHaveTextContent('missed schedule time')
    expect(within(rows[1]).queryByRole('button', { name: /View result/ })).toBeNull()
    expect(rows[2]).toHaveTextContent('Failed')
    expect(rows[2]).toHaveTextContent('31s')
    expect(rows[2]).toHaveTextContent('—')
  })

  it('opens a run result rendered as markdown and toggles to raw text', async () => {
    mockApi(sched())
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'View result of digest-2' }))
    const viewer = await screen.findByRole('region', { name: 'run result' })
    // react-markdown is a heavy first import; give it time on a loaded CI box.
    const rendered = await within(viewer).findByTestId('result-rendered', {}, { timeout: 10000 })
    expect(mockApiGet).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest/runs/digest-2')
    expect(within(rendered).getByRole('heading', { name: 'Digest' })).toBeInTheDocument()
    expect(rendered.querySelector('strong')).toHaveTextContent('All quiet')

    fireEvent.click(within(viewer).getByRole('button', { name: 'Raw' }))
    expect(within(viewer).queryByTestId('result-rendered')).toBeNull()
    expect(within(viewer).getByTestId('result-raw').textContent).toBe(result.output)

    fireEvent.click(within(viewer).getByRole('button', { name: 'Rendered' }))
    expect(within(viewer).getByTestId('result-rendered')).toBeInTheDocument()
  }, 20000)

  it('shows the manifest YAML verbatim and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mockApi(sched())
    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: 'YAML' }))
    const pre = await screen.findByTestId('schedule-yaml')
    expect(mockApiGetText).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest/manifest')
    expect(pre.textContent).toBe(YAML)
    fireEvent.click(screen.getByRole('button', { name: /Copy YAML/ }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(YAML))
    expect(await screen.findByRole('button', { name: /Copied/ })).toBeInTheDocument()
  })

  it('hides Delete for a Git-managed schedule but keeps Run now and Suspend', async () => {
    mockApi(sched({ managedBy: 'git' }))
    renderPage()
    const actions = await screen.findByTestId('schedule-actions')
    expect(screen.getByText('managed in Git')).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: /Run now/ })).toBeInTheDocument()
    expect(within(actions).getByRole('button', { name: /Suspend/ })).toBeInTheDocument()
    expect(within(actions).queryByRole('button', { name: /Delete/ })).toBeNull()
  })

  it('confirms Run now with the task before firing', async () => {
    mockApi(sched())
    mockApiPost.mockResolvedValue({ schedule: 'morning-digest', namespace: 'roundtable', run: 'digest-3', state: 'started' })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Run now/ }))
    expect(screen.getByTestId('run-now-task')).toHaveTextContent('chain digest')
    expect(mockApiPost).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest/run', {}))
    expect(await screen.findByRole('status')).toHaveTextContent('Started run digest-3')
  })

  it('resumes a suspended schedule and shows the gateway message', async () => {
    mockApi(sched({ suspended: true }))
    mockApiPost.mockResolvedValue({ name: 'morning-digest', namespace: 'roundtable', suspended: true, suspendedBy: 'spec', message: 'spec.suspend is still true' })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Resume/ }))
    await waitFor(() => expect(mockApiPost).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest/resume', {}))
    expect(await screen.findByRole('status')).toHaveTextContent('spec.suspend is still true')
  })

  it('deletes an API-managed schedule after confirmation and returns to the list', async () => {
    mockApi(sched())
    mockApiDelete.mockResolvedValue(undefined)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Delete/ }))
    const dialogDelete = screen.getAllByRole('button', { name: 'Delete' }).at(-1)!
    fireEvent.click(dialogDelete)
    await waitFor(() => expect(mockApiDelete).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest'))
    expect(await screen.findByText('schedules list')).toBeInTheDocument()
  })
})
