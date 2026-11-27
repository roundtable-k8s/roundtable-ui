import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { GlanceStrip } from './GlanceStrip'
import { apiGet } from '../lib/api'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))

type Fix = { health?: unknown; dead?: unknown; schedules?: unknown; queues?: unknown; fail?: string }
function mockApi(f: Fix) {
  vi.mocked(apiGet).mockImplementation((url: string) => {
    const key = url.startsWith('/api/health') ? 'health' : url.startsWith('/api/dead') || url.includes('dead') ? 'dead' : url.startsWith('/api/schedules') ? 'schedules' : 'queues'
    if (f.fail === key) return Promise.reject(new Error('boom'))
    return Promise.resolve((f as Record<string, unknown>)[key] as never)
  })
}
const healthy: Fix = {
  health: { kubernetes: 'ok', nats: 'connected' },
  dead: { deadLetters: [] },
  schedules: { schedules: [] },
  queues: [],
}
const renderStrip = (knights: { status: string }[] | null = [{ status: 'online' }]) =>
  render(<MemoryRouter><GlanceStrip knights={knights as never} /></MemoryRouter>)

beforeEach(() => { vi.mocked(apiGet).mockReset() })

describe('GlanceStrip', () => {
  it('shows a single All clear when healthy', async () => {
    mockApi(healthy)
    renderStrip()
    expect(await screen.findByText('All clear')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
  })
  it('warns when NATS is reconnecting', async () => {
    mockApi({ ...healthy, health: { kubernetes: 'ok', nats: 'reconnecting' } })
    renderStrip()
    expect(await screen.findByText('NATS reconnecting')).toHaveAttribute('data-tone', 'warn')
  })
  it('links open failed tasks to /failed', async () => {
    mockApi({ ...healthy, dead: { deadLetters: [{ table: '' }, { table: '' }] } })
    renderStrip()
    expect(await screen.findByRole('link', { name: '2 open failed tasks' })).toHaveAttribute('href', '/failed')
  })
  it('reports offline knights, failing schedules and backed-up queues', async () => {
    mockApi({
      ...healthy,
      schedules: { schedules: [{ lastResult: { time: 't', outcome: 'failed' } }] },
      queues: [{ consumerFound: true, oldestWaitSeconds: 900, pending: 1, freeSlots: 0 }],
    })
    renderStrip([{ status: 'offline' }])
    expect(await screen.findByRole('link', { name: '1 knight not ready' })).toHaveAttribute('href', '/fleet?status=offline')
    expect(await screen.findByRole('link', { name: '1 schedule failing' })).toHaveAttribute('href', '/schedules')
    expect(await screen.findByRole('link', { name: '1 queue backed up' })).toHaveAttribute('href', '/queues')
  })
  it('shows a failing source as unknown, not ok', async () => {
    mockApi({ ...healthy, fail: 'queues' })
    renderStrip()
    expect(await screen.findByText('Queues unknown')).toHaveAttribute('data-tone', 'unknown')
    expect(screen.queryByText('All clear')).toBeNull()
  })
  it('shows the API chip as unknown when /api/health fails', async () => {
    mockApi({ ...healthy, fail: 'health' })
    renderStrip()
    expect(await screen.findByText('API status unknown')).toHaveAttribute('data-tone', 'unknown')
    expect(screen.queryByText('All clear')).toBeNull()
  })
  it('shows unknown knights when the fleet failed to load', async () => {
    mockApi(healthy)
    renderStrip(null)
    expect(await screen.findByText('Knights unknown')).toBeInTheDocument()
  })
})
