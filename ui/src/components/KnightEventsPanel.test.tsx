import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { KnightEventsPanel } from './KnightEventsPanel'

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

function mockFetch(res: () => Response | Promise<Response>) {
  const f = vi.fn(async () => res())
  vi.stubGlobal('fetch', f)
  return f
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('KnightEventsPanel', () => {
  beforeEach(() => { vi.restoreAllMocks() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows a warning with label, reason, message, count and age', async () => {
    const f = mockFetch(() => json([
      { type: 'Warning', reason: 'TaskLost', message: 'task abc lost', count: 3, lastTimestamp: iso(5 * 60_000) },
      { type: 'Normal', reason: 'Scaled', message: 'ok', count: 1, lastTimestamp: iso(3_600_000) },
    ]))
    render(<KnightEventsPanel knight="galahad" />)
    expect(await screen.findByText('TaskLost')).toBeInTheDocument()
    expect(screen.getByText('Warning')).toBeInTheDocument()
    expect(screen.getByText('task abc lost')).toBeInTheDocument()
    expect(screen.getByText('×3')).toBeInTheDocument()
    expect(screen.getByText('5m ago')).toBeInTheDocument()
    expect(String((f.mock.calls[0] as unknown[])[0])).toContain('/api/fleet/galahad/events')
  })

  it('shows the empty state', async () => {
    mockFetch(() => json([]))
    render(<KnightEventsPanel knight="galahad" />)
    expect(await screen.findByText('No recent events')).toBeInTheDocument()
  })

  it('shows an error instead of the empty state', async () => {
    mockFetch(() => json({ error: 'Failed to list events' }, 502))
    render(<KnightEventsPanel knight="galahad" />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(screen.queryByText('No recent events')).toBeNull()
  })
})
