import { render, screen, within, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { QueuesPage, QueuesTable } from './Queues'
import { appendSamples, type KnightQueue, type QueueHistory } from '../lib/queues'

const T0 = Date.parse('2026-11-24T12:00:00Z')

function queue(over: Partial<KnightQueue> = {}): KnightQueue {
  return {
    knight: 'galahad', stream: 'fleet_a_tasks', consumer: 'galahad-consumer', consumerFound: true,
    pending: 0, ackPending: 0, redelivered: 0, waiting: 2, oldestWaitSeconds: 0,
    concurrency: 2, replicas: 1, readyReplicas: 1, freeSlots: 2, ...over,
  }
}

describe('QueuesTable', () => {
  it('shows the backlog after 10 tasks hit a knight with 2 free slots, with a growing wait badge and the scale-up', () => {
    const at = new Date(T0).toISOString()
    const backlog = queue({
      pending: 8, ackPending: 2, waiting: 0, freeSlots: 0, oldestPendingAt: at, oldestWaitSeconds: 0,
    })
    // KEDA scales 1 → 3 replicas while the backlog drains.
    let history: QueueHistory = {}
    history = appendSamples(history, [backlog], T0)
    history = appendSamples(history, [backlog], T0 + 15_000)
    history = appendSamples(history, [{ ...backlog, replicas: 3, readyReplicas: 1 }], T0 + 30_000)

    const { rerender } = render(<QueuesTable queues={[backlog]} history={history} now={T0 + 60_000} />)
    const row = screen.getByTestId('queue-row-galahad')
    const cells = within(row).getAllByRole('cell')
    expect(cells[1]).toHaveTextContent('8') // pending
    expect(cells[2]).toHaveTextContent('2') // ack-pending
    expect(cells[4]).toHaveTextContent('1m 0s') // oldest wait
    expect(cells[5]).toHaveTextContent('0') // free slots
    expect(within(row).queryByTestId('warning-oldest-wait')).toBeNull()
    expect(within(row).getAllByTestId('scale-up')).toHaveLength(1)

    rerender(<QueuesTable queues={[backlog]} history={history} now={T0 + 6 * 60_000} />)
    expect(within(row).getByTestId('warning-oldest-wait')).toHaveTextContent('Waiting 6m 0s')
  })

  it('shows replicas as ready/current/max and the saturation badge at max', () => {
    const q = queue({ pending: 4, ackPending: 6, freeSlots: 0, replicas: 3, readyReplicas: 3, maxReplicas: 3 })
    render(<QueuesTable queues={[q]} history={{}} now={T0} />)
    const row = screen.getByTestId('queue-row-galahad')
    expect(within(row).getByText('3/3/3')).toBeInTheDocument()
    expect(within(row).getByTestId('warning-saturated')).toBeInTheDocument()
    expect(within(row).getByText('collecting…')).toBeInTheDocument()
  })

  it('shows an unknown max as a dash and marks knights without a consumer', () => {
    render(<QueuesTable queues={[queue({ knight: 'kay', consumerFound: false, waiting: 0, freeSlots: 0, readyReplicas: 0, replicas: 0 })]} history={{}} now={T0} />)
    const row = screen.getByTestId('queue-row-kay')
    expect(within(row).getByText('0/0/—')).toBeInTheDocument()
    expect(within(row).getByText('no consumer yet')).toBeInTheDocument()
  })

  it('links each knight to Grafana when configured', () => {
    render(<QueuesTable queues={[queue()]} history={{}} now={T0} grafanaUrl="https://grafana.example.com/d/queues" />)
    expect(screen.getByLabelText('Grafana history for galahad'))
      .toHaveAttribute('href', 'https://grafana.example.com/d/queues?var-knight=galahad')
  })

  it('renders no Grafana link for an unsafe URL', () => {
    render(<QueuesTable queues={[queue()]} history={{}} now={T0} grafanaUrl="javascript:alert(1)" />)
    expect(screen.queryByLabelText('Grafana history for galahad')).toBeNull()
  })
})

describe('QueuesPage', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('loads /api/queues and the Grafana link from /api/config', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      const body = url.includes('/api/config')
        ? { fleetPrefix: 'fleet-a', grafanaQueuesUrl: 'https://grafana.example.com/d/queues' }
        : [queue({ pending: 8, ackPending: 2, freeSlots: 0 })]
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    render(<QueuesPage />)
    expect(await screen.findByTestId('queue-row-galahad')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Grafana history').closest('a'))
      .toHaveAttribute('href', 'https://grafana.example.com/d/queues'))
  })

  it('shows an error banner when the API is unavailable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('JetStream not available', { status: 503 }))
    render(<QueuesPage />)
    expect(await screen.findByText(/JetStream not available/)).toBeInTheDocument()
  })
})
