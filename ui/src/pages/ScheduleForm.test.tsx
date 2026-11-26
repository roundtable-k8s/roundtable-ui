import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ScheduleFormPage, NextRunsPreview } from './ScheduleForm'
import { apiGet, apiPost, apiPut, ApiError } from '../lib/api'
import type { CardEntry } from '../lib/cards'
import knightJson from '../lib/__fixtures__/schedule-manifests/knight.json?raw'
import knightYaml from '../lib/__fixtures__/schedule-manifests/knight.yaml?raw'

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>()
  return { ApiError: actual.ApiError, apiGet: vi.fn(), apiPost: vi.fn(), apiPut: vi.fn() }
})
vi.mock('../hooks/useTables', () => ({ useTables: () => ['fleet-a', 'fleet-b'] }))
const card = (table: string, knight: string) => ({ table, knight, card: { skills: [], roundtable: {} }, live: true, stats: null }) as CardEntry
vi.mock('../hooks/useCards', () => ({
  useCards: () => ({
    cards: new Map([['fleet-a.galahad', card('fleet-a', 'galahad')], ['fleet-b.percival', card('fleet-b', 'percival')]]),
    loading: false, unavailable: false,
  }),
}))

const mockGet = vi.mocked(apiGet)
const mockPost = vi.mocked(apiPost)
const mockPut = vi.mocked(apiPut)

function serve(managedBy = 'api') {
  mockGet.mockImplementation((url: string) => {
    if (url === '/api/config') return Promise.resolve({ fleetPrefix: 'fleet', namespace: 'roundtable' })
    if (url.startsWith('/api/chains')) return Promise.resolve([{ name: 'daily-digest', roundTableRef: 'fleet-a' }, { name: 'other', roundTableRef: 'fleet-b' }])
    if (url === '/api/schedules/roundtable/morning-brief') return Promise.resolve({ name: 'morning-brief', namespace: 'roundtable', managedBy })
    if (url === '/api/schedules/roundtable/morning-brief/manifest?format=json') return Promise.resolve(JSON.parse(knightJson))
    return Promise.reject(new Error(`unexpected ${url}`))
  })
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/schedules" element={<div>schedules list</div>} />
        <Route path="/schedules/new" element={<ScheduleFormPage />} />
        <Route path="/schedules/:namespace/:name/edit" element={<ScheduleFormPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

const yaml = () => screen.getByTestId('schedule-yaml').textContent ?? ''
const change = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
  mockPut.mockReset()
})

describe('ScheduleFormPage: new schedule', () => {
  it('builds the YAML live for a knight task, with the knights of the chosen table', async () => {
    serve()
    renderAt('/schedules/new')
    await waitFor(() => expect(screen.getByLabelText('Namespace')).toHaveValue('roundtable'))
    change('Name', 'morning-brief')
    change('Table', 'fleet-a')
    const knight = screen.getByLabelText('Knight')
    expect(within(knight).queryByText('percival')).toBeNull()
    expect(within(knight).getByText('galahad')).toBeInTheDocument()
    change('Knight', 'galahad')
    change('Task', 'Summarise the overnight alerts.')
    expect(yaml()).toContain('kind: Trigger')
    expect(yaml()).toContain('  name: morning-brief\n  namespace: roundtable\n')
    expect(yaml()).toContain('    knight:\n      name: galahad\n      task: Summarise the overnight alerts.\n      timeoutSeconds: 3600\n')
    expect(yaml()).toContain('  roundTableRef:\n    name: fleet-a\n')
  })

  it('switches the YAML to a chain and to a mission target', async () => {
    serve()
    renderAt('/schedules/new')
    fireEvent.click(screen.getByRole('radio', { name: /Chain/ }))
    await waitFor(() => expect(screen.getByLabelText('Chain').tagName).toBe('SELECT'))
    change('Chain', 'daily-digest')
    change('Input (optional)', 'Digest for {{ .Event.Time }}')
    expect(yaml()).toContain('    chainRef:\n      name: daily-digest\n')
    expect(yaml()).toContain('  input: Digest for {{ .Event.Time }}\n')
    fireEvent.click(screen.getByRole('radio', { name: /Mission/ }))
    change('Objective', 'Review the week')
    change('Cost budget (USD)', '2.50')
    expect(yaml()).toContain('    mission:\n      costBudgetUSD: "2.50"\n      metaMission: true\n      objective: Review the week\n')
    expect(yaml()).not.toContain('input:')
    expect(within(screen.getByLabelText('Concurrency policy')).queryByText('Replace')).toBeNull()
  })

  it('previews the next three runs in the chosen time zone, and cron presets fill the cron', async () => {
    serve()
    renderAt('/schedules/new')
    fireEvent.click(screen.getByRole('button', { name: 'Mondays at 09:00' }))
    expect(screen.getByLabelText('Cron')).toHaveValue('0 9 * * 1')
    change('Time zone', 'Asia/Tokyo')
    const preview = screen.getByTestId('next-runs')
    expect(preview).toHaveTextContent('Next runs (Asia/Tokyo)')
    const items = within(preview).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    for (const li of items) expect(li).toHaveTextContent(/^Mon, .* 09:00$/)
    change('Cron', '61 * * * *')
    expect(screen.getByTestId('next-runs')).toHaveTextContent('minute: 61 is above the maximum 59')
  })

  it('POSTs the schedule and goes back to the list', async () => {
    serve()
    mockPost.mockResolvedValue({ name: 'nightly', namespace: 'roundtable', managedBy: 'api' })
    renderAt('/schedules/new')
    await waitFor(() => expect(screen.getByLabelText('Namespace')).toHaveValue('roundtable'))
    change('Name', 'nightly')
    change('Knight', 'galahad')
    change('Task', 'Check')
    fireEvent.click(screen.getByRole('button', { name: /Create schedule/ }))
    await screen.findByText('schedules list')
    expect(mockPost).toHaveBeenCalledWith('/api/schedules', {
      name: 'nightly', namespace: 'roundtable',
      spec: {
        source: { schedule: { cron: '0 7 * * 1-5', timeZone: 'UTC' } },
        target: { knight: { name: 'galahad', task: 'Check', timeoutSeconds: 3600 } },
        concurrency: { policy: 'Forbid' }, ttlSecondsAfterFinished: 86400,
      },
    })
  })

  it('shows the gateway field error next to the matching field', async () => {
    serve()
    mockPost.mockRejectedValue(new ApiError(400, 'invalid request: spec.source.schedule.cron: "every day" is not a valid cron expression', 'spec.source.schedule.cron'))
    renderAt('/schedules/new')
    change('Name', 'x')
    fireEvent.click(screen.getByRole('button', { name: /Create schedule/ }))
    const err = await screen.findByTestId('error-schedule-cron')
    expect(err).toHaveTextContent('"every day" is not a valid cron expression')
    expect(screen.queryByText('schedules list')).toBeNull()
    // Editing the field clears its error.
    change('Cron', '0 8 * * *')
    expect(screen.queryByTestId('error-schedule-cron')).toBeNull()
  })

  it('shows an error without a field, and a conflict, above the form', async () => {
    serve()
    mockPost.mockRejectedValue(new ApiError(409, 'conflict: trigger roundtable/x already exists'))
    renderAt('/schedules/new')
    change('Name', 'x')
    fireEvent.click(screen.getByRole('button', { name: /Create schedule/ }))
    expect(await screen.findByText(/already exists/)).toBeInTheDocument()
  })
})

describe('ScheduleFormPage: edit', () => {
  it('starts from the manifest, previews it unchanged and PUTs the change', async () => {
    serve()
    mockPut.mockResolvedValue({})
    renderAt('/schedules/roundtable/morning-brief/edit')
    await waitFor(() => expect(screen.getByLabelText('Knight')).toHaveValue('galahad'))
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(yaml()).toBe(knightYaml)
    change('Cron', '0 6 * * 1-5')
    expect(yaml()).toContain('      cron: 0 6 * * 1-5\n')
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await screen.findByText('schedules list')
    expect(mockPut).toHaveBeenCalledWith('/api/schedules/roundtable/morning-brief', expect.objectContaining({
      name: 'morning-brief', namespace: 'roundtable',
      spec: expect.objectContaining({ source: { schedule: { cron: '0 6 * * 1-5', timeZone: 'Europe/Berlin' } } }),
    }))
  })

  it('keeps hidden fields when the kind is switched to chain and back', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.endsWith('/manifest?format=json')) {
        const m = JSON.parse(knightJson)
        m.spec.input = undefined
        m.spec.concurrency = { ...m.spec.concurrency, maxActive: 3 }
        m.spec.dedupeKey = 'brief-{{date}}'
        return Promise.resolve(m)
      }
      if (url === '/api/schedules/roundtable/morning-brief') return Promise.resolve({ name: 'morning-brief', namespace: 'roundtable', managedBy: 'api' })
      if (url.startsWith('/api/chains')) return Promise.resolve([{ name: 'daily-digest' }])
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    mockPut.mockResolvedValue({})
    renderAt('/schedules/roundtable/morning-brief/edit')
    await waitFor(() => expect(screen.getByLabelText('Knight')).toHaveValue('galahad'))
    fireEvent.click(screen.getByRole('radio', { name: /Chain/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Task to a knight/ }))
    await waitFor(() => expect(screen.getByLabelText('Knight')).toHaveValue('galahad'))
    fireEvent.click(screen.getByRole('button', { name: /Save changes/ }))
    await screen.findByText('schedules list')
    const spec = mockPut.mock.calls[0][1] as { spec: Record<string, any> }
    expect(spec.spec.dedupeKey).toBe('brief-{{date}}')
    expect(spec.spec.concurrency.maxActive).toBe(3)
  })

  it('offers no form for a Git-managed schedule', async () => {
    serve('git')
    renderAt('/schedules/roundtable/morning-brief/edit')
    expect(await screen.findByTestId('managed-in-git')).toHaveTextContent('managed in Git')
    expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
    expect(mockPut).not.toHaveBeenCalled()
  })
})

describe('NextRunsPreview', () => {
  it('lists three runs', () => {
    render(<NextRunsPreview cron="0 7 * * *" timeZone="UTC" now={new Date('2026-11-25T18:00:00Z')} />)
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Thu, 26 Nov 2026, 07:00', 'Fri, 27 Nov 2026, 07:00', 'Sat, 28 Nov 2026, 07:00',
    ])
  })
})
