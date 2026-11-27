import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { SchedulesPage } from './Schedules'
import { apiGet, apiPost, apiDelete } from '../lib/api'
import type { Schedule } from '../lib/schedules'
import type { Trigger } from '../lib/triggers'

vi.mock('../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn() }))
const mockApiGet = vi.mocked(apiGet)
const mockApiPost = vi.mocked(apiPost)
const mockApiDelete = vi.mocked(apiDelete)

function sched(over: Partial<Schedule>): Schedule {
  return {
    name: 's', namespace: 'roundtable', table: 'fleet-a', cron: '0 7 * * 1-5', timeZone: 'Europe/Berlin',
    description: 'at 07:00 on Monday to Friday', target: { kind: 'chain', summary: 'chain digest', chain: 'digest' },
    suspended: false, managedBy: 'api', ...over,
  }
}

const next = new Date(Date.now() + 2 * 3600_000).toISOString()
const schedules: Schedule[] = [
  sched({
    name: 'morning-digest', managedBy: 'git', nextRunAt: next,
    lastResult: { time: new Date(Date.now() - 3600_000).toISOString(), outcome: 'started', run: 'digest-1' },
  }),
  sched({
    name: 'cluster-scan', table: 'fleet-b', cron: '0 3 * * *', timeZone: 'UTC', description: 'at 03:00',
    target: { kind: 'knight', summary: 'knight galahad', knight: 'galahad' }, suspended: true,
    lastResult: { time: new Date(Date.now() - 7200_000).toISOString(), outcome: 'failed', run: 'invoke-1' },
  }),
  sched({ name: 'weekly-report', target: { kind: 'knight', summary: 'knight gawain', knight: 'gawain' } }),
]

const triggers = [
  { name: 'cluster-scan', namespace: 'roundtable', task: 'Scan the cluster for drift\nThen open issues' },
  { name: 'morning-digest', namespace: 'roundtable', task: 'Digest for {{ .Event.Time }}' },
] as Trigger[]

function serve(list: Schedule[] = schedules) {
  mockApiGet.mockImplementation((url: string) => {
    if (url.startsWith('/api/schedules')) return Promise.resolve({ schedules: list })
    if (url === '/api/triggers') return Promise.resolve(triggers)
    return Promise.reject(new Error(`unexpected ${url}`))
  })
}

function UrlProbe() {
  return <span data-testid="url-search">{useLocation().search}</span>
}

function renderPage(path = '/schedules') {
  return render(<MemoryRouter initialEntries={[path]}><UrlProbe /><SchedulesPage /></MemoryRouter>)
}

async function rowFor(name: string) {
  const rows = (await screen.findAllByRole('row')).slice(1)
  const row = rows.find((r) => within(r).queryByText(name))
  if (!row) throw new Error(`no row for ${name}`)
  return row
}

beforeEach(() => {
  mockApiGet.mockReset()
  mockApiPost.mockReset()
  mockApiDelete.mockReset()
})

describe('SchedulesPage', () => {
  it('shows the empty state with a docs link when there are no schedules', async () => {
    serve([])
    renderPage()
    const empty = await screen.findByTestId('schedules-empty')
    expect(empty).toHaveTextContent('A schedule runs a task')
    expect(within(empty).getByRole('link', { name: /docs/i })).toHaveAttribute('href', expect.stringContaining('docs/gateway.md#schedules'))
  })

  it('lists schedules with target, task, cadence, next and last run, state and managed-by', async () => {
    serve()
    renderPage()
    const digest = await rowFor('morning-digest')
    expect(screen.getByText(/^3 schedules · What runs on a cadence/)).toBeInTheDocument()
    expect(digest).toHaveTextContent('digest')
    expect(digest).toHaveTextContent('Digest for {{ .Event.Time }}')
    expect(within(digest).getByText('at 07:00 on Monday to Friday')).toHaveAttribute('title', '0 7 * * 1-5 (Europe/Berlin)')
    expect(digest).toHaveTextContent('in 1h')
    expect(digest).toHaveTextContent('1h ago started')
    expect(digest).toHaveTextContent('Active')
    expect(within(digest).getByTestId('managed-git')).toHaveTextContent('managed in Git')
    expect(within(digest).getByLabelText('chain')).toBeInTheDocument()

    const scan = await rowFor('cluster-scan')
    expect(within(scan).getByTestId('schedule-task')).toHaveTextContent(/^Scan the cluster for drift$/)
    expect(within(scan).getByLabelText('knight')).toBeInTheDocument()
    expect(scan).toHaveTextContent('galahad')
    expect(scan).toHaveTextContent('failed')
    expect(scan).toHaveTextContent('Suspended')
    expect(within(scan).getByRole('button', { name: 'Resume cluster-scan' })).toBeInTheDocument()
    expect(within(scan).queryByTestId('managed-git')).toBeNull()
  })

  it('has no Delete for a Git-managed schedule, but Run now, Suspend', async () => {
    serve()
    renderPage()
    const digest = await rowFor('morning-digest')
    expect(within(digest).queryByRole('button', { name: /Delete/ })).toBeNull()
    expect(within(digest).getByRole('link', { name: 'morning-digest' })).toHaveAttribute('href', '/schedules/roundtable/morning-digest')
    expect(within(digest).getByRole('button', { name: 'Run morning-digest now' })).toBeInTheDocument()
    expect(within(digest).getByRole('button', { name: 'Suspend morning-digest' })).toBeInTheDocument()
    expect(within(await rowFor('weekly-report')).getByRole('button', { name: 'Delete weekly-report' })).toBeInTheDocument()
  })

  it('runs a Git-managed schedule after a confirmation that shows the task', async () => {
    serve()
    mockApiPost.mockResolvedValue({ schedule: 'morning-digest', namespace: 'roundtable', run: 'digest-2', state: 'started', target: 'chain' })
    renderPage()
    fireEvent.click(within(await rowFor('morning-digest')).getByRole('button', { name: 'Run morning-digest now' }))
    const dialog = await screen.findByTestId('run-now-dialog')
    expect(screen.getByRole('dialog', { name: 'Run morning-digest now?' })).toBeInTheDocument()
    expect(within(dialog).getByTestId('run-now-task')).toHaveTextContent('Digest for {{ .Event.Time }}')
    expect(mockApiPost).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run now' }))
    expect(await screen.findByTestId('schedule-notice')).toHaveTextContent('Started morning-digest: digest-2')
    expect(mockApiPost).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest/run', {})
    expect(screen.queryByTestId('run-now-dialog')).toBeNull()
  })

  it('shows the gateway answer when run now is skipped', async () => {
    serve()
    mockApiPost.mockRejectedValue(new Error('concurrency Forbid: run digest-1 is active'))
    renderPage()
    fireEvent.click(within(await rowFor('morning-digest')).getByRole('button', { name: 'Run morning-digest now' }))
    fireEvent.click(within(await screen.findByTestId('run-now-dialog')).getByRole('button', { name: 'Run now' }))
    expect(await screen.findByTestId('schedule-notice')).toHaveTextContent('concurrency Forbid')
  })

  it('suspends and resumes, showing a spec.suspend message', async () => {
    serve()
    mockApiPost.mockImplementation((url: string) => Promise.resolve(url.endsWith('/resume')
      ? { name: 'cluster-scan', namespace: 'roundtable', suspended: true, suspendedBy: 'spec', message: 'spec.suspend is still true' }
      : { name: 'morning-digest', namespace: 'roundtable', suspended: true, suspendedBy: 'annotation' }))
    renderPage()
    fireEvent.click(within(await rowFor('morning-digest')).getByRole('button', { name: 'Suspend morning-digest' }))
    expect(await screen.findByTestId('schedule-notice')).toHaveTextContent('Suspended morning-digest')
    expect(mockApiPost).toHaveBeenCalledWith('/api/schedules/roundtable/morning-digest/suspend', {})
    fireEvent.click(within(await rowFor('cluster-scan')).getByRole('button', { name: 'Resume cluster-scan' }))
    await waitFor(() => expect(screen.getByTestId('schedule-notice')).toHaveTextContent('cluster-scan: spec.suspend is still true'))
    expect(mockApiPost).toHaveBeenCalledWith('/api/schedules/roundtable/cluster-scan/resume', {})
  })

  it('deletes after a confirmation', async () => {
    serve()
    mockApiDelete.mockResolvedValue(null)
    renderPage()
    fireEvent.click(within(await rowFor('weekly-report')).getByRole('button', { name: 'Delete weekly-report' }))
    const dialog = await screen.findByTestId('delete-dialog')
    expect(screen.getByRole('dialog', { name: 'Delete weekly-report?' })).toBeInTheDocument()
    expect(mockApiDelete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByTestId('schedule-notice')).toHaveTextContent('Deleted weekly-report')
    expect(mockApiDelete).toHaveBeenCalledWith('/api/schedules/roundtable/weekly-report')
  })

  it('filters by knight', async () => {
    serve()
    renderPage()
    await rowFor('morning-digest')
    fireEvent.change(screen.getByLabelText('Knight'), { target: { value: 'galahad' } })
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('cluster-scan')
  })

  it('keeps the knight filter in the URL', async () => {
    serve()
    renderPage('/schedules?knight=galahad')
    await rowFor('cluster-scan')
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Knight'), { target: { value: 'gawain' } })
    expect(screen.getByTestId('url-search')).toHaveTextContent('?knight=gawain')
    fireEvent.change(screen.getByLabelText('Knight'), { target: { value: '' } })
    expect(screen.getByTestId('url-search').textContent).toBe('')
  })

  it('filters by state and keeps it in the URL', async () => {
    serve()
    renderPage()
    await rowFor('morning-digest')
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'suspended' } })
    expect(screen.getByTestId('url-search')).toHaveTextContent('?state=suspended')
    const rows = screen.getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent('cluster-scan')
    expect(screen.getByText(/^1 of 3 schedules/)).toBeInTheDocument()
  })

  it('starts filtered from the ?state= URL parameter', async () => {
    serve()
    renderPage('/schedules?state=failing')
    await rowFor('cluster-scan')
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(1)
    expect(screen.getByLabelText('State')).toHaveValue('failing')
  })

  it('treats an unknown state in the URL as all', async () => {
    serve()
    renderPage('/schedules?state=bogus')
    await rowFor('morning-digest')
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(3)
    expect(screen.getByLabelText('State')).toHaveValue('all')
  })

  it('shows the empty state with counts when no schedule matches the state', async () => {
    serve([sched({ name: 'quiet', suspended: false })])
    renderPage('/schedules?state=failing')
    expect(await screen.findByText('No schedules match the filter')).toBeInTheDocument()
    expect(screen.getByText('0 of 1 schedule shown. Clear the state or knight filter to see them.')).toBeInTheDocument()
  })

  it('shows the empty filtered state for a knight with no schedules', async () => {
    serve()
    renderPage('/schedules?knight=nobody')
    expect(await screen.findByTestId('schedules-empty')).toHaveTextContent('No schedules match the filter')
    expect(screen.queryAllByRole('row')).toHaveLength(0)
  })

  it('filters by the table in the URL', async () => {
    serve()
    renderPage('/schedules?table=fleet-b')
    await rowFor('cluster-scan')
    expect(mockApiGet).toHaveBeenCalledWith('/api/schedules?table=fleet-b', expect.anything())
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(1)
  })

  it('has no Edit for a Git-managed schedule, and an Edit link to the form otherwise', async () => {
    serve()
    renderPage()
    const digest = await rowFor('morning-digest')
    expect(within(digest).queryByRole('link', { name: /Edit/ })).toBeNull()
    expect(within(await rowFor('weekly-report')).getByRole('link', { name: 'Edit weekly-report' }))
      .toHaveAttribute('href', '/schedules/roundtable/weekly-report/edit')
  })

  it('links to the new schedule form', async () => {
    serve([])
    renderPage()
    expect(await screen.findByRole('link', { name: /New schedule/ })).toHaveAttribute('href', '/schedules/new')
  })

  it('links to the Triggers page', async () => {
    serve([])
    renderPage()
    expect(await screen.findByRole('link', { name: /All triggers/ })).toHaveAttribute('href', '/triggers')
  })

  it('shows an error banner when loading fails', async () => {
    mockApiGet.mockImplementation((url: string) => (url.startsWith('/api/schedules') ? Promise.reject(new Error('Gateway not configured')) : Promise.resolve([])))
    renderPage()
    expect(await screen.findByText(/Failed to load schedules: Gateway not configured/)).toBeInTheDocument()
  })
})

describe('SchedulesPage policy and suspension', () => {
  it('shows the concurrency policy under the cadence and what suspends a schedule', async () => {
    serve([
      sched({ name: 'capped', concurrency: { policy: 'Allow', maxActive: 3 } }),
      sched({ name: 'paused', suspended: true, suspendedBy: 'spec,annotation', concurrency: { policy: 'Forbid' } }),
      sched({ name: 'plain' }),
    ])
    renderPage()
    expect(await rowFor('capped')).toHaveTextContent('Allow, up to 3 active')
    const paused = await rowFor('paused')
    expect(within(paused).getByTestId('schedule-policy')).toHaveTextContent('Forbid')
    expect(within(paused).getByTestId('schedule-suspended-by')).toHaveTextContent('suspended by spec and annotation')
    const plain = await rowFor('plain')
    expect(within(plain).queryByTestId('schedule-policy')).toBeNull()
    expect(within(plain).queryByTestId('schedule-suspended-by')).toBeNull()
  })

  it('shows Pause all and Resume all only when a table is selected', async () => {
    serve()
    renderPage()
    await rowFor('morning-digest')
    expect(screen.queryByRole('button', { name: /Pause all/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Resume all/ })).toBeNull()
  })

  it('hides Pause all and Resume all for the none table and sends no table none', async () => {
    serve([sched({ name: 'loose-digest', table: undefined })])
    renderPage('/schedules?table=none')
    await rowFor('loose-digest')
    expect(screen.queryByRole('button', { name: /Pause all/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Resume all/ })).toBeNull()
    expect(mockApiPost).not.toHaveBeenCalled()
  })

  it('pauses every schedule of the table after a confirmation and shows the summary with failures', async () => {
    serve()
    mockApiPost.mockResolvedValue({
      table: 'fleet-a', changed: ['morning-digest'], unchanged: [], failed: [{ name: 'weekly-report', error: 'gateway timeout' }],
    })
    renderPage('/schedules?table=fleet-a')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause all in fleet-a' }))
    const dialog = await screen.findByTestId('table-action-dialog')
    expect(dialog).toHaveTextContent('Suspend 2 schedules of table fleet-a? Nothing is deleted; Resume all undoes it.')
    expect(mockApiPost).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pause all' }))
    const notice = await screen.findByTestId('schedule-notice')
    expect(notice).toHaveTextContent('Paused 1, 0 already paused, 1 failed')
    expect(within(notice).getByTestId('schedule-notice-failed')).toHaveTextContent('weekly-report: gateway timeout')
    expect(mockApiPost).toHaveBeenCalledTimes(1)
    expect(mockApiPost).toHaveBeenCalledWith('/api/schedules/suspend', { table: 'fleet-a', namespace: 'roundtable' })
    expect(mockApiGet).toHaveBeenCalledWith('/api/schedules?table=fleet-a', expect.anything())
  })

  it('resumes the suspended schedules of the table and reports the unchanged ones', async () => {
    serve()
    mockApiPost.mockResolvedValue({ table: 'fleet-b', changed: [], unchanged: ['cluster-scan'], failed: [] })
    renderPage('/schedules?table=fleet-b')
    fireEvent.click(await screen.findByRole('button', { name: 'Resume all in fleet-b' }))
    fireEvent.click(within(await screen.findByTestId('table-action-dialog')).getByRole('button', { name: 'Resume all' }))
    expect(await screen.findByTestId('schedule-notice')).toHaveTextContent('Resumed 0, 1 already running, 0 failed')
    expect(mockApiPost).toHaveBeenCalledWith('/api/schedules/resume', { table: 'fleet-b', namespace: 'roundtable' })
  })

  it('sends nothing when the table action is cancelled', async () => {
    serve()
    renderPage('/schedules?table=fleet-a')
    fireEvent.click(await screen.findByRole('button', { name: 'Pause all in fleet-a' }))
    fireEvent.click(within(await screen.findByTestId('table-action-dialog')).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByTestId('table-action-dialog')).toBeNull())
    expect(mockApiPost).not.toHaveBeenCalled()
  })
})
