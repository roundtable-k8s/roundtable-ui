import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueuesPage, QueuesTable } from './Queues'
import { apiGet } from '../lib/api'
import type { KnightQueue, KnightQueueHistory, QueueSample } from '../lib/queues'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))

function queue(over: Partial<KnightQueue> = {}): KnightQueue {
  return {
    knight: 'galahad', stream: 'fleet_a_tasks', consumer: 'galahad-consumer', consumerFound: true,
    pending: 0, ackPending: 0, redelivered: 0, waiting: 2,
    delivered: { consumerSeq: 0, streamSeq: 0 }, ackFloor: { consumerSeq: 0, streamSeq: 0 },
    oldestWaitSeconds: 0, concurrency: 2, replicas: 1, readyReplicas: 1, freeSlots: 2,
    ...over,
  }
}

function sample(t: string, over: Partial<QueueSample> = {}): QueueSample {
  return { t, pending: 0, ackPending: 0, redelivered: 0, waiting: 0, replicas: 1, readyReplicas: 1, maxReplicas: 3, ...over }
}

function history(over: Partial<KnightQueueHistory> = {}): KnightQueueHistory {
  return {
    knight: 'galahad', intervalSeconds: 15, retentionSeconds: 21600,
    samples: [
      sample('2026-11-24T10:00:00Z', { pending: 8, ackPending: 2 }),
      sample('2026-11-24T10:00:15Z', { pending: 8, ackPending: 2 }),
      sample('2026-11-24T10:00:30Z', { pending: 4, ackPending: 4, replicas: 2, readyReplicas: 2 }),
    ],
    events: [{ t: '2026-11-24T10:00:20Z', direction: 'up', from: 1, to: 2, reason: 'scaled on consumer lag', source: 'hpa', k8sReason: 'SuccessfulRescale' }],
    ...over,
  }
}

const mockApiGet = vi.mocked(apiGet)

function mockApi(queues: KnightQueue[] | Error, hist: KnightQueueHistory[] | Error) {
  mockApiGet.mockImplementation((url: string) => {
    const v = url.startsWith('/api/queues/history') ? hist : url.startsWith('/api/queues') ? queues : new Error('unexpected ' + url)
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
  })
}

describe('QueuesPage', () => {
  beforeEach(() => { mockApiGet.mockReset() })

  it('does not claim zero pending while loading', () => {
    mockApiGet.mockImplementation(() => new Promise(() => {}))
    render(<MemoryRouter><QueuesPage /></MemoryRouter>)
    expect(screen.getByText(/… pending · … in flight/)).toBeInTheDocument()
    expect(screen.queryByText(/0 pending/)).toBeNull()
  })

  it('shows an empty state when there are no knights', async () => {
    mockApi([], [])
    render(<MemoryRouter><QueuesPage /></MemoryRouter>)
    expect(await screen.findByText('No knight queues found.')).toBeInTheDocument()
    expect(mockApiGet).toHaveBeenCalledWith('/api/queues', expect.anything())
    expect(mockApiGet).toHaveBeenCalledWith('/api/queues/history?since=1h', expect.anything())
  })

  it('shows a backlog: 8 pending, oldest wait and the scale-up in the sparkline', async () => {
    mockApi(
      [queue({ pending: 8, ackPending: 2, freeSlots: 0, oldestWaitSeconds: 420 })],
      [history()],
    )
    render(<MemoryRouter><QueuesPage /></MemoryRouter>)
    const row = await screen.findByTestId('queue-row-galahad')
    const cells = within(row).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('8')
    expect(cells[2]).toHaveTextContent('2')
    expect(cells[4]).toHaveTextContent('7m')
    expect(cells[5]).toHaveTextContent('0 / 2')
    expect(cells[6]).toHaveTextContent('1 / 3')
    expect(within(row).getByTestId('warning-oldest-wait')).toHaveTextContent('Waiting 7m')
    expect(within(row).queryByTestId('warning-saturated')).toBeNull()
    const events = within(row).getAllByTestId('scale-event')
    expect(events).toHaveLength(1)
    expect(events[0].textContent).toContain('1 → 2 replicas (hpa): scaled on consumer lag')
  })

  it('names the table and scopes its headers', async () => {
    mockApi([queue()], [history()])
    render(<MemoryRouter><QueuesPage /></MemoryRouter>)
    const table = await screen.findByRole('table', { name: 'Queues' })
    for (const th of within(table).getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col')
  })

  it('shows ack-pending-only work without warnings', async () => {
    mockApi([queue({ ackPending: 2, freeSlots: 0, oldestWaitSeconds: 30 })], [history()])
    render(<MemoryRouter><QueuesPage /></MemoryRouter>)
    const row = await screen.findByTestId('queue-row-galahad')
    const cells = within(row).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('0')
    expect(cells[2]).toHaveTextContent('2')
    expect(cells[4]).toHaveTextContent('30s')
    expect(within(row).queryByTestId(/^warning-/)).toBeNull()
  })

  it('still renders the table when history is unavailable', async () => {
    mockApi([queue({ pending: 1 })], new Error('Queue history not available'))
    render(<MemoryRouter><QueuesPage /></MemoryRouter>)
    expect(await screen.findByTestId('queue-row-galahad')).toHaveTextContent('No history')
    await waitFor(() => expect(screen.getByText(/Scaling history unavailable/)).toBeInTheDocument())
  })

  it('shows an error banner when queues fail to load', async () => {
    mockApi(new Error('JetStream not available'), [])
    render(<MemoryRouter><QueuesPage /></MemoryRouter>)
    expect(await screen.findByText(/Failed to load queues: JetStream not available/)).toBeInTheDocument()
  })
})

describe('QueuesTable', () => {
  it('flags a knight at max replicas with no free slots', () => {
    render(<QueuesTable queues={[queue({ pending: 5, freeSlots: 0, replicas: 3, readyReplicas: 3, ackPending: 6 })]} history={[history()]} />)
    expect(screen.getByTestId('warning-saturated')).toHaveTextContent('At max replicas')
  })

  it('marks knights without a consumer and with errors', () => {
    render(<QueuesTable
      queues={[queue({ consumerFound: false }), queue({ knight: 'kay', consumer: 'kay-consumer', error: 'consumer lookup failed' })]}
      history={[]}
    />)
    expect(screen.getByText('No consumer yet')).toBeInTheDocument()
    expect(screen.getByText('consumer lookup failed')).toBeInTheDocument()
  })

  it('links to Grafana only for http(s) URLs', () => {
    const { rerender } = render(<QueuesTable queues={[queue()]} history={[history({ grafanaUrl: 'https://grafana.example/d/queues?var-knight=galahad' })]} />)
    expect(screen.getByRole('link', { name: /Grafana/ })).toHaveAttribute('href', 'https://grafana.example/d/queues?var-knight=galahad')
    rerender(<QueuesTable queues={[queue()]} history={[history({ grafanaUrl: 'javascript:alert(1)' })]} />)
    expect(screen.queryByRole('link', { name: /Grafana/ })).toBeNull()
  })
})

describe('QueuesPage table filter', () => {
  it('asks for one table and shows only its knights', async () => {
    const all = [queue({ knight: 'galahad', table: 'personal' }), queue({ knight: 'rt-ui', table: 'roundtable-dev' })]
    mockApiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/queues/history')) return Promise.resolve([])
      const t = new URL(url, 'http://x').searchParams.get('table')
      return Promise.resolve(all.filter((q) => !t || q.table === t))
    })
    render(<MemoryRouter initialEntries={['/queues?table=personal']}><QueuesPage /></MemoryRouter>)
    expect(await screen.findByTestId('queue-row-galahad')).toBeInTheDocument()
    expect(screen.queryByTestId('queue-row-rt-ui')).toBeNull()
    expect(mockApiGet).toHaveBeenCalledWith('/api/queues?table=personal', expect.anything())
    expect(screen.queryByTestId('table-badge')).toBeNull()
  })

  it('badges each row with its table when all tables are shown', async () => {
    mockApi([queue({ knight: 'galahad', table: 'personal' }), queue({ knight: 'rt-ui', table: 'roundtable-dev' })], [])
    render(<MemoryRouter><QueuesPage /></MemoryRouter>)
    await screen.findByTestId('queue-row-rt-ui')
    expect(screen.getAllByTestId('table-badge').map((b) => b.textContent)).toEqual(['personal', 'roundtable-dev'])
  })
})
