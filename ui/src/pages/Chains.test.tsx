import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ChainsPage, FALLBACK_POLL_MS } from './Chains'
import { apiGet } from '../lib/api'
import { fanOutChain, prPipelineChain } from '../test/fixtures/chains'
import type { Chain } from '../lib/types'
import apiFanout from '../test/fixtures/api/fanout.json'
import apiLoop from '../test/fixtures/api/pr-pipeline-loop.json'
import type { TopicListener } from '../hooks/useWebSocket'

vi.mock('../lib/api', () => ({ apiGet: vi.fn() }))

let connected = true
const listeners = new Map<string, Set<TopicListener>>()
vi.mock('../hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    connected,
    events: [],
    send: () => true,
    subscribeTopic: (topic: string, fn: TopicListener) => {
      if (!listeners.has(topic)) listeners.set(topic, new Set())
      listeners.get(topic)!.add(fn)
      return () => { listeners.get(topic)!.delete(fn) }
    },
  }),
}))

const mockApiGet = vi.mocked(apiGet)

function emitChain(chain: Partial<Chain>, op = 'upsert') {
  act(() => listeners.get('chain')?.forEach(fn => fn(chain, { type: 'chain', op, data: chain })))
}

function renderPage(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ChainsPage />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  connected = true
  listeners.clear()
  mockApiGet.mockReset()
  mockApiGet.mockImplementation((url: string) =>
    url === '/api/chains' ? Promise.resolve([fanOutChain(), prPipelineChain()]) : Promise.reject(new Error('no KV')))
})

afterEach(() => { vi.useRealTimers() })

describe('ChainsPage fan-out', () => {
  it('shows a progress bar with done/running/failed/omitted and the running items with pod and activity link', async () => {
    renderPage('/chains?chain=doc-sweep')
    const step = await screen.findByRole('region', { name: 'step review-each' })

    const bar = within(step).getByRole('progressbar', { name: 'review-each progress' })
    expect(bar).toHaveAttribute('aria-valuemax', '12')
    expect(bar).toHaveAttribute('aria-valuenow', '7')
    expect(step).toHaveTextContent('6 done · 2 running · 1 failed · 3 pending of 12')
    expect(step).toHaveTextContent('(5 finished not listed)')
    expect(step).toHaveTextContent('max 2 parallel')

    // Running step → item list is expanded by default
    const rows = within(step).getAllByRole('row').slice(1)
    expect(rows.map(r => within(r).getAllByRole('cell')[0].textContent)).toEqual(['7', '8', '3', '6', '5 more finished items not listed'])
    expect(rows[0]).toHaveTextContent('lancelot-7f9c')
    expect(rows[0]).toHaveTextContent('4s ago')
    expect(within(rows[0]).getByRole('link', { name: /activity/ })).toHaveAttribute('href', '/running?task=task-item-7')
    expect(rows[1]).toHaveTextContent('30s')
    expect(rows[2]).toHaveTextContent('timeout after 600s')
    expect(rows[2]).toHaveTextContent('retry 2')
    expect(within(rows[2]).queryByRole('link')).toBeNull()
    expect(rows[3]).toHaveTextContent('2.0 KB')

    // Collapses back to the bar
    await userEvent.click(within(step).getByRole('button', { name: 'review-each items' }))
    expect(within(step).queryAllByRole('row')).toHaveLength(0)
  })

  it('shows why a step was skipped', async () => {
    renderPage('/chains?chain=doc-sweep')
    const step = await screen.findByRole('region', { name: 'step publish' })
    expect(step).toHaveTextContent("Skipped: when condition was false: steps['review-each'].failed == 0")
  })
})

describe('ChainsPage loop', () => {
  it('shows the current round, its running body step and past rounds', async () => {
    renderPage('/chains?chain=pr-pipeline')
    const step = await screen.findByRole('region', { name: 'step review-fix' })
    expect(step).toHaveTextContent('round 2/5')
    expect(step).toHaveTextContent('on exhausted: fail')
    expect(step).toHaveTextContent('galahad-5d8e')
    expect(within(step).getAllByRole('link', { name: /activity/ })[0]).toHaveAttribute('href', '/running?task=task-r2')
    expect(step).toHaveTextContent('Past rounds (1)')
    const past = within(step).getByRole('listitem', { name: 'round 1' })
    expect(past).toHaveTextContent('review')
    expect(past).toHaveTextContent('fix')
  })
})

describe('ChainsPage live updates', () => {
  it('applies chain WS messages without refetching', async () => {
    renderPage('/chains?chain=pr-pipeline')
    const step = await screen.findByRole('region', { name: 'step review-fix' })
    expect(step).toHaveTextContent('round 2/5')
    expect(mockApiGet).toHaveBeenCalledTimes(1)

    const next = prPipelineChain()
    next.steps![1].loop!.iteration = 3
    next.steps![1].loop!.rounds!.push({ iteration: 3, steps: [{ name: 'review', phase: 'Running', iteration: 3, inFlight: { pod: 'galahad-new', elapsedMs: 1000 } }] })
    emitChain(next)

    expect(screen.getByRole('region', { name: 'step review-fix' })).toHaveTextContent('round 3/5')
    expect(screen.getByRole('region', { name: 'step review-fix' })).toHaveTextContent('galahad-new')

    emitChain({ name: 'pr-pipeline', namespace: 'roundtable' }, 'delete')
    expect(screen.queryByText('pr-pipeline')).toBeNull()
    expect(screen.getByText('doc-sweep')).toBeInTheDocument()
    expect(mockApiGet).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('replays updates that arrive while the list is loading', async () => {
    let resolve!: (v: Chain[]) => void
    mockApiGet.mockImplementation(() => new Promise(r => { resolve = r as (v: Chain[]) => void }))
    renderPage('/chains?chain=pr-pipeline')
    emitChain({ ...prPipelineChain(), phase: 'Succeeded' })
    await act(async () => { resolve([fanOutChain(), prPipelineChain()]) })
    const card = await screen.findByText('pr-pipeline')
    expect(card.closest('button')).toHaveTextContent('Succeeded')
  })

  it('only polls (slowly) while the live feed is disconnected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    connected = false
    renderPage('/chains')
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1))
    expect(screen.getByText(/Live feed disconnected — polling every 30s/)).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(FALLBACK_POLL_MS) })
    expect(mockApiGet).toHaveBeenCalledTimes(2)
  })

  it('does not poll while connected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage('/chains')
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(1))
    await act(async () => { vi.advanceTimersByTime(FALLBACK_POLL_MS * 3) })
    expect(mockApiGet).toHaveBeenCalledTimes(1)
  })
})

// Fixtures in test/fixtures/api are the real API output (api/testdata/chains/*.json
// run through parseChainResource + joinChainInFlight), so these guard the DTO shape.
describe('ChainsPage with real API payloads', () => {
  it('shows pod, elapsed, heartbeat, output size and max parallel for a running fan-out item', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === '/api/chains' ? Promise.resolve([apiFanout, apiLoop]) : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=fanout-scan')
    const step = await screen.findByRole('region', { name: 'step scan' })
    expect(step).toHaveTextContent('max 2 parallel')
    const row = within(step).getAllByRole('row').slice(1).find(r => within(r).getAllByRole('cell')[0].textContent === '8')!
    expect(row).toHaveTextContent('galahad-abc-1')
    expect(row).toHaveTextContent('10s ago')
    const finished = within(step).getAllByRole('row').slice(1).find(r => within(r).getAllByRole('cell')[0].textContent === '7')!
    expect(finished).toHaveTextContent('11 B')
  })

  it('shows the pod of a running loop body step', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === '/api/chains' ? Promise.resolve([apiFanout, apiLoop]) : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=pr-pipeline-roundtable-ui-187')
    const step = await screen.findByRole('region', { name: 'step fixloop' })
    expect(step).toHaveTextContent('galahad-abc-1')
  })
})
