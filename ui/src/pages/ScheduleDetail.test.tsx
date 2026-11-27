import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ScheduleDetailPage } from './ScheduleDetail'
import { apiDelete, apiGet, apiGetText, apiPost } from '../lib/api'
import type { Schedule, ScheduleRun, ScheduleRunResult } from '../lib/schedules'
import { resetConfigCache } from '../hooks/useConfig'

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

const agentRuns: ScheduleRun[] = [
  { run: 'digest-3', time: '2026-11-26T07:00:00Z', outcome: 'succeeded', turns: 7, toolCalls: 0, resultAvailable: true },
  { run: 'digest-4', time: '2026-11-27T07:00:00Z', outcome: 'succeeded', turns: 4, resultAvailable: true },
]

const knightResult: ScheduleRunResult = {
  schedule: 'morning-digest', target: 'knight', run: 'digest-3',
  task: {
    run: 'digest-3', knight: 'galahad', status: 'Succeeded', output: 'knight said hi', model: 'sonnet', verdict: 'approved',
    prs: [
      { repo: 'o/r', number: 1, url: 'https://github.com/o/r/pull/1', action: 'opened' },
      { repo: '<b>x</b>', number: 2, url: 'javascript:alert(1)' },
    ],
  },
}

const missionResult: ScheduleRunResult = {
  schedule: 'morning-digest', target: 'mission', run: 'digest-4',
  mission: { phase: 'Failed', result: 'mission result text' },
}

const YAML = 'apiVersion: ai.roundtable.io/v1alpha1\nkind: Trigger\nmetadata:\n  name: morning-digest\n'

function mockApi(s: Schedule, extra: ScheduleRun[] = []) {
  mockApiGet.mockImplementation(async (url: string) => {
    if (url === '/api/schedules/roundtable/morning-digest') return s
    if (url.startsWith('/api/schedules/roundtable/morning-digest/runs?')) return { runs: [...runs, ...extra] }
    if (url === '/api/schedules/roundtable/morning-digest/runs/digest-2') return result
    if (url.endsWith('/runs/digest-3')) return knightResult
    if (url.endsWith('/runs/digest-4')) return missionResult
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
  resetConfigCache()
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
    expect(mockApiGet).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest/runs?limit=50', expect.anything())
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

  it('links the trace of a run that has one when a trace viewer is configured', async () => {
    const traceId = '0af7651916cd43dd8448eb211c80319c'
    const withTrace = runs.map((r) => (r.run === 'digest-2' ? { ...r, traceId } : r))
    mockApiGet.mockImplementation(async (url: string) => {
      if (url === '/api/config') return { traceUrlTemplate: 'https://t.example/trace/{traceId}' }
      if (url === '/api/schedules/roundtable/morning-digest') return sched()
      if (url.startsWith('/api/schedules/roundtable/morning-digest/runs?')) return { runs: withTrace }
      if (url.endsWith('/runs/digest-3')) return knightResult
    if (url.endsWith('/runs/digest-4')) return missionResult
    throw new Error(`unexpected ${url}`)
    })
    mockApiGetText.mockResolvedValue(YAML)
    renderPage()
    const history = await screen.findByRole('region', { name: 'run history' })
    const link = await within(history).findByRole('link', { name: /View trace/ })
    expect(link).toHaveAttribute('href', `https://t.example/trace/${traceId}`)
    expect(within(history).getAllByRole('link', { name: /View trace/ })).toHaveLength(1)
  })

  it('names the run history table and scopes its headers', async () => {
    mockApi(sched())
    renderPage()
    const table = await screen.findByRole('table', { name: /run history/i })
    for (const th of within(table).getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col')
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

  it('shows turns and tool calls only where reported', async () => {
    mockApi(sched(), agentRuns)
    renderPage()
    const table = await screen.findByRole('table', { name: /run history/i })
    expect(within(table).getByText('7 turns · 0 tool calls')).toBeInTheDocument()
    expect(within(table).getByText('4 turns')).toBeInTheDocument()
    expect(within(table).queryByText(/4 turns ·/)).toBeNull()
  })

  it('shows a knight-target run output, status, model and PRs as text', async () => {
    mockApi(sched(), agentRuns)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'View result of digest-3' }))
    const viewer = await screen.findByRole('region', { name: 'run result' })
    await within(viewer).findByText('Succeeded')
    expect(await within(viewer).findByText('knight said hi', {}, { timeout: 10000 })).toBeInTheDocument()
    expect(within(viewer).getByText('sonnet')).toBeInTheDocument()
    expect(within(viewer).getByText('approved')).toBeInTheDocument()
    expect(within(viewer).queryByText(/object Object/)).toBeNull()
    expect(within(viewer).getByRole('link', { name: 'o/r#1' })).toHaveAttribute('href', 'https://github.com/o/r/pull/1')
    expect(within(viewer).getByText('<b>x</b>#2')).toBeInTheDocument()
    expect(within(viewer).queryByRole('link', { name: /#2/ })).toBeNull()
    expect(viewer.querySelector('b')).toBeNull()
  }, 20000)

  it('shows a mission-target run result and its phase', async () => {
    mockApi(sched(), agentRuns)
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'View result of digest-4' }))
    const viewer = await screen.findByRole('region', { name: 'run result' })
    expect(await within(viewer).findByText('mission result text', {}, { timeout: 10000 })).toBeInTheDocument()
    expect(within(viewer).getByText('Failed')).toBeInTheDocument()
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
    expect(within(actions).queryByRole('link', { name: /Edit/ })).toBeNull()
  })

  it('links to the edit form for a schedule that is not Git-managed', async () => {
    mockApi(sched())
    renderPage()
    const actions = await screen.findByTestId('schedule-actions')
    expect(within(actions).getByRole('link', { name: /Edit/ })).toHaveAttribute('href', '/schedules/roundtable/morning-digest/edit')
  })

  it('shows the skip reason of a run-now the gateway answers with 409', async () => {
    mockApi(sched())
    mockApiPost.mockRejectedValue(Object.assign(new Error('conflict: concurrency Forbid: run digest-1 is active'), { status: 409 }))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Run now/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(await screen.findByText(/concurrency Forbid: run digest-1 is active/)).toBeInTheDocument()
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

describe('ScheduleDetailPage policy block', () => {
  it('shows the policy, starting deadline and suspension source', async () => {
    mockApi(sched({
      suspended: true, suspendedBy: 'spec,annotation',
      concurrency: { policy: 'Forbid' }, startingDeadlineSeconds: 300,
    }))
    renderPage()
    const policy = await screen.findByRole('region', { name: 'policy' })
    expect(policy).toHaveTextContent('Forbid')
    expect(policy).toHaveTextContent('Starting deadline5m 0s')
    expect(policy).toHaveTextContent('Suspension sourcespec and annotation')
  })

  it('shows the cap in the policy and none for an unset starting deadline', async () => {
    mockApi(sched({ concurrency: { policy: 'Allow', maxActive: 2 } }))
    renderPage()
    const policy = await screen.findByRole('region', { name: 'policy' })
    expect(policy).toHaveTextContent('Allow, up to 2 active')
    expect(policy).toHaveTextContent('Starting deadlinenone')
    expect(policy).not.toHaveTextContent('Suspension source')
  })

  it('renders no policy block when the gateway omits the fields', async () => {
    mockApi(sched())
    renderPage()
    await screen.findByRole('region', { name: 'summary' })
    expect(screen.queryByRole('region', { name: 'policy' })).toBeNull()
  })
})
