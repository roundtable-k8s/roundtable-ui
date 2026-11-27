import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { KnightRecentWork } from './KnightRecentWork'

const fetchMock = vi.fn()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function route(tasks: () => Response, schedules: () => Response) {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(url.startsWith('/api/gateway/tasks') ? tasks() : url.startsWith('/api/schedules') ? schedules() : json({}, 404)))
}
const view = () => render(<MemoryRouter><KnightRecentWork knight="galahad" /></MemoryRouter>)

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })

describe('KnightRecentWork', () => {
  it('renders task and schedule rows with links', async () => {
    route(
      () => json({ tasks: [{ taskId: 't-1', status: 'succeeded', cost: 0.0023, durationMs: 4500, createdAt: new Date().toISOString() }] }),
      () => json({ schedules: [
        { name: 'nightly', namespace: 'ns', cron: '0 2 * * *', timeZone: 'UTC', suspended: true, managedBy: 'api', target: { kind: 'knight', knight: 'galahad', summary: '' } },
        { name: 'other', namespace: 'ns', cron: '* * * * *', timeZone: 'UTC', suspended: false, managedBy: 'api', target: { kind: 'knight', knight: 'bors', summary: '' } },
      ] }),
    )
    view()
    const task = await screen.findByRole('link', { name: 't-1' })
    expect(task).toHaveAttribute('href', '/running?task=t-1')
    expect(screen.getByText('$0.0023')).toBeInTheDocument()
    expect(screen.getByText('4.5s')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'nightly' })).toHaveAttribute('href', '/schedules/ns/nightly')
    expect(screen.getByText('Suspended')).toBeInTheDocument()
    expect(screen.queryByText('other')).toBeNull()
    expect(fetchMock.mock.calls[0][0]).toContain('knight=galahad&limit=10')
  })

  it('shows both empty states', async () => {
    route(() => json({ tasks: [] }), () => json({ schedules: [] }))
    view()
    expect(await screen.findByText('No recent tasks')).toBeInTheDocument()
    expect(await screen.findByText('No schedules target this knight')).toBeInTheDocument()
  })

  it('shows a gateway failure in the section only', async () => {
    route(() => json({ error: 'GATEWAY_URL not configured' }, 503), () => json({ schedules: [] }))
    view()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to load recent tasks'))
    expect(screen.getByText('The gateway is not configured on this dashboard.')).toBeInTheDocument()
    expect(await screen.findByText('No schedules target this knight')).toBeInTheDocument()
  })
})
