import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within, act, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { ChainsPage, CHAINS_LIST_URL, CHAIN_GROUPS_URL, FALLBACK_POLL_MS, GROUP_PAGE_SIZE, GROUP_REFRESH_MS } from './Chains'
import { apiGet, apiGetWithTotal, apiPost, apiFetch } from '../lib/api'
import { fanOutChain, prPipelineChain } from '../test/fixtures/chains'
import type { Chain } from '../lib/types'
import apiFanout from '../test/fixtures/api/fanout.json'
import apiLoop from '../test/fixtures/api/pr-pipeline-loop.json'
import apiCost from '../test/fixtures/api/cost.json'
import type { TopicListener } from '../hooks/useWebSocket'

vi.mock('../lib/api', () => {
  const apiGet = vi.fn()
  // Lists load through apiGetWithTotal; by default it wraps apiGet with no total.
  const apiGetWithTotal = vi.fn((url: string, init?: unknown) =>
    apiGet(url, init).then((items: unknown) => ({ items, total: null })))
  return { apiGet, apiGetWithTotal, apiPost: vi.fn(), apiFetch: vi.fn() }
})

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

/** Calls of the top-level chain list (the page also asks for groups and the focused chain). */
const listCalls = () => mockApiGet.mock.calls.filter(c => c[0] === CHAINS_LIST_URL).length

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
    url === CHAINS_LIST_URL ? Promise.resolve([fanOutChain(), prPipelineChain()]) : Promise.reject(new Error('no KV')))
})

afterEach(() => { vi.useRealTimers() })

describe('ChainsPage fan-out', () => {
  it('shows a progress bar with done/running/failed/omitted and the running items with pod and activity link', async () => {
    renderPage('/chains?chain=doc-sweep')
    const step = await screen.findByRole('region', { name: 'step review-each' })
    expect(screen.getByText('2 chains')).toBeInTheDocument()

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

  it('names the step item table and scopes its headers', async () => {
    renderPage('/chains?chain=doc-sweep')
    const step = await screen.findByRole('region', { name: 'step review-each' })
    const table = within(step).getByRole('table', { name: 'Chain steps' })
    for (const th of within(table).getAllByRole('columnheader')) expect(th).toHaveAttribute('scope', 'col')
  })

  it('shows why a step was skipped', async () => {
    renderPage('/chains?chain=doc-sweep')
    const step = await screen.findByRole('region', { name: 'step publish' })
    expect(step).toHaveTextContent("Skipped: when evaluated to false: steps['review-each'].failed == 0")
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
    expect(listCalls()).toBe(1)

    const next = prPipelineChain()
    next.steps![1].loop!.iteration = 3
    next.steps![1].loop!.rounds!.push({ iteration: 3, steps: [{ name: 'review', phase: 'Running', iteration: 3, inFlight: { pod: 'galahad-new', elapsedMs: 1000 } }] })
    emitChain(next)

    expect(screen.getByRole('region', { name: 'step review-fix' })).toHaveTextContent('round 3/5')
    expect(screen.getByRole('region', { name: 'step review-fix' })).toHaveTextContent('galahad-new')

    emitChain({ name: 'pr-pipeline', namespace: 'roundtable' }, 'delete')
    expect(screen.queryByText('pr-pipeline')).toBeNull()
    expect(screen.getByText('doc-sweep')).toBeInTheDocument()
    expect(listCalls()).toBe(1)
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('replays updates that arrive while the list is loading', async () => {
    let resolve!: (v: Chain[]) => void
    mockApiGet.mockImplementation((url: string) => url === CHAINS_LIST_URL
      ? new Promise(r => { resolve = r as (v: Chain[]) => void })
      : Promise.reject(new Error('not found')))
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
    await waitFor(() => expect(listCalls()).toBe(1))
    expect(screen.getByText(/Live feed disconnected — polling every 30s/)).toBeInTheDocument()
    await act(async () => { vi.advanceTimersByTime(FALLBACK_POLL_MS) })
    expect(listCalls()).toBe(2)
  })

  it('does not poll while connected', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    renderPage('/chains')
    await waitFor(() => expect(listCalls()).toBe(1))
    await act(async () => { vi.advanceTimersByTime(FALLBACK_POLL_MS * 3) })
    expect(listCalls()).toBe(1)
  })
})

// Fixtures in test/fixtures/api are the real API output (api/testdata/chains/*.json
// run through parseChainResource + joinChainInFlight), so these guard the DTO shape.
describe('ChainsPage with real API payloads', () => {
  it('shows pod, elapsed, heartbeat, output size and max parallel for a running fan-out item', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([apiFanout, apiLoop]) : Promise.reject(new Error('no KV')))
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
      url === CHAINS_LIST_URL ? Promise.resolve([apiFanout, apiLoop]) : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=pr-pipeline-roundtable-ui-187')
    const step = await screen.findByRole('region', { name: 'step fixloop' })
    expect(step).toHaveTextContent('galahad-abc-1')
  })
})

describe('ChainsPage loop history', () => {
  it('lists every round newest first, flags failed rounds and shows error and output summary', async () => {
    const chain = structuredClone(apiLoop) as typeof apiLoop
    const loop = chain.steps.find(s => s.name === 'fixloop')!.loop as unknown as { iteration: number; rounds: unknown[] }
    loop.iteration = 3
    loop.rounds = [
      { iteration: 1, steps: [
        { name: 'fix', iteration: 1, phase: 'Failed', taskId: 't-fix-1', error: 'task timed out <b>x</b>', outputBytes: 0 },
        { name: 'rereview', iteration: 1, phase: 'Succeeded', taskId: 't-rr-1', outputBytes: 12, outputSummary: 'needs fixes one' }] },
      { iteration: 2, steps: [{ name: 'fix', iteration: 2, phase: 'Succeeded', taskId: 't-fix-2', outputBytes: 3 }] },
      { iteration: 3, steps: [{ name: 'fix', iteration: 3, phase: 'Running', taskId: 't-fix-3', outputBytes: 0 }] },
    ]
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([chain]) : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=pr-pipeline-roundtable-ui-187')
    const step = await screen.findByRole('region', { name: 'step fixloop' })
    expect(step).toHaveTextContent('Past rounds (2)')
    const items = within(step).getAllByRole('listitem')
    expect(items.map(i => i.getAttribute('aria-label'))).toEqual(['round 2', 'round 1'])
    const r1 = within(step).getByRole('listitem', { name: 'round 1' })
    expect(r1).toHaveTextContent('failed')
    expect(r1).toHaveTextContent('task timed out <b>x</b>')
    expect(r1.querySelector('b')).toBeNull()
    expect(r1).toHaveTextContent('needs fixes one')
    expect(within(step).getByRole('listitem', { name: 'round 2' })).not.toHaveTextContent('failed')
  })
})

describe('ChainsPage cost', () => {
  it('shows cost and tokens per step and a run total equal to their sum, marking notional cost', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([apiCost]) : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=cost-run')
    const table = await screen.findByRole('table', { name: 'cost-run cost' })
    const rows = within(table).getAllByRole('row')
    const row = (name: string) => rows.find(r => within(r).queryAllByRole('cell')[0]?.textContent === name)!

    expect(row('plan')).toHaveTextContent('$0.25')
    expect(within(row('plan')).getByText('notional')).toBeInTheDocument()
    expect(row('plan')).toHaveTextContent('10k in / 1.5k out')
    expect(row('build')).toHaveTextContent('$0.50')
    expect(within(row('build')).queryByText('notional')).toBeNull()
    // A step without cost data shows a dash.
    expect(within(row('notify')).getAllByRole('cell')[2]).toHaveTextContent('—')
    expect(within(row('notify')).getAllByRole('cell')[3]).toHaveTextContent('—')

    const total = row('Total')
    const stepSum = apiCost.steps.reduce((sum, s) => sum + Number((s as { costUSD?: string }).costUSD ?? 0), 0)
    expect(Number(apiCost.costUSD)).toBeCloseTo(stepSum, 6)
    expect(total).toHaveTextContent('$0.75')
    expect(total).toHaveTextContent('incl. $0.25 notional')
    expect(total).toHaveTextContent('30k in / 4.5k out')

    // The collapsed header shows the run total too.
    expect(screen.getByRole('button', { name: /cost-run/ })).toHaveTextContent('$0.75')
  })

  it('shows cost and tokens in the step detail', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([apiCost]) : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=cost-run')
    await screen.findByRole('table', { name: 'cost-run cost' })
    const buttons = screen.getAllByRole('button').filter(b => b.textContent?.trim().endsWith('plan'))
    await userEvent.click(buttons[buttons.length - 1])
    expect(screen.getByText('Cost:').parentElement).toHaveTextContent('$0.25notional')
    expect(screen.getByText('Tokens:').parentElement).toHaveTextContent('10k in / 1.5k out')
  })

  it('renders runs without cost data with dashes', async () => {
    renderPage('/chains?chain=doc-sweep')
    const table = await screen.findByRole('table', { name: 'doc-sweep cost' })
    const total = within(table).getAllByRole('row').at(-1)!
    expect(total).toHaveTextContent('Total——')
  })
})

describe('ChainsPage run now', () => {
  it('shows Run now only for chains the gateway can run, posts the input and links to the run', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL
        ? Promise.resolve([{ ...fanOutChain(), invokable: true }, { ...prPipelineChain(), name: 'closed-chain' }])
        : Promise.reject(new Error('no KV')))
    vi.mocked(apiPost).mockResolvedValue({ run: 'doc-sweep-x1', namespace: 'roundtable', phase: 'Pending', done: false })
    renderPage('/chains?chain=doc-sweep')

    const box = await screen.findByTestId('run-now')
    expect(screen.getAllByTestId('run-now')).toHaveLength(1)

    await userEvent.type(within(box).getByRole('textbox'), 'topic: nats')
    await userEvent.click(within(box).getByRole('button', { name: /run now/i }))
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/chains/doc-sweep/run', { namespace: 'roundtable', input: 'topic: nats' }, { headers: { 'Idempotency-Key': expect.any(String) } }))
    const link = await within(box).findByRole('link', { name: 'doc-sweep-x1' })
    expect(link.getAttribute('href')).toBe('/chains?chain=doc-sweep-x1')
  })

  it('offers no Run now on mission chains or run copies', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([{ ...fanOutChain(), invokable: true, missionRef: 'm1' }]) : Promise.reject(new Error('no KV')))
    const { unmount } = renderPage('/chains?chain=doc-sweep')
    expect(await screen.findAllByText('m1')).not.toHaveLength(0)
    expect(screen.queryByTestId('run-now')).toBeNull()
    unmount()
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([{ ...fanOutChain(), invokable: true, runTemplate: 'doc-sweep' }]) : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=doc-sweep')
    await screen.findAllByText('doc-sweep')
    expect(screen.queryByTestId('run-now')).toBeNull()
  })

  it('shows the error when the run cannot be started', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([{ ...fanOutChain(), invokable: true }]) : Promise.reject(new Error('no KV')))
    vi.mocked(apiPost).mockRejectedValue(new Error('Gateway not configured'))
    renderPage('/chains?chain=doc-sweep')
    const box = await screen.findByTestId('run-now')
    await userEvent.click(within(box).getByRole('button', { name: /run now/i }))
    expect((await within(box).findByRole('alert')).textContent).toContain('Gateway not configured')
  })
})

// #275: the list is slim and excludes run copies, which are grouped by template.
describe('ChainsPage run copies grouped by template', () => {
  const ago = (sec: number) => new Date(Date.now() - sec * 1000).toISOString()
  const slim = (c: Chain): Chain => ({
    ...c, slim: true, steps: (c.steps || []).map(s => ({ name: s.name, phase: s.phase }) as Chain['steps'] extends (infer T)[] | null ? T : never),
  })
  const template = (): Chain => slim({ ...prPipelineChain(), phase: 'Succeeded', startTime: ago(7200), completionTime: ago(7000) })
  const scheduled = (): Chain => slim({ ...fanOutChain(), name: 'morning-briefing', schedule: '0 6 * * *', phase: 'Succeeded' })
  const copy = (i: number, phase = 'Succeeded'): Chain => slim({
    ...prPipelineChain(), name: `pr-pipeline-roundtable-${i}`, runTemplate: 'pr-pipeline', phase,
    startTime: ago(2000 + i * 60), completionTime: phase === 'Running' ? null : ago(1900 + i * 60),
  })
  const group = {
    template: 'pr-pipeline', runs: 150, templateExists: true, lastStartTime: ago(33 * 60 + 5),
    phases: { Succeeded: 148, PartiallySucceeded: 1, Failed: 1 },
  }

  /** Routes the page's GETs; run pages are served from `copies` by offset/limit. */
  function mockFleet(opts: { copies?: Chain[]; details?: Record<string, Chain> } = {}) {
    const copies = opts.copies ?? Array.from({ length: 150 }, (_, i) => copy(i))
    mockApiGet.mockImplementation((url: string) => {
      if (url === CHAINS_LIST_URL) return Promise.resolve([template(), scheduled()])
      if (url === CHAIN_GROUPS_URL) return Promise.resolve([group])
      const runs = url.match(/^\/api\/chains\?template=pr-pipeline&offset=(\d+)&limit=(\d+)$/)
      if (runs) return Promise.resolve(copies.slice(Number(runs[1]), Number(runs[1]) + Number(runs[2])))
      const detail = url.match(/^\/api\/chains\/([^/?]+)$/)
      if (detail && opts.details?.[decodeURIComponent(detail[1])]) return Promise.resolve(opts.details[decodeURIComponent(detail[1])])
      return Promise.reject(new Error('not found'))
    })
  }
  const groupRow = () => screen.getByRole('button', { name: /^pr-pipeline: 150 runs/ })
  const runCalls = () => mockApiGet.mock.calls.map(c => c[0] as string).filter(u => u.startsWith('/api/chains?template='))

  it('shows templates and scheduled chains first and the copies as one collapsed row', async () => {
    mockFleet()
    renderPage('/chains')
    const row = await screen.findByRole('button', { name: /^pr-pipeline: 150 runs/ })
    expect(row).toHaveTextContent('pr-pipeline: 150 runs, 148 succeeded, 1 partially succeeded, 1 failed, last 33m ago')
    expect(row).toHaveAttribute('aria-expanded', 'false')

    // Template and scheduled chain come before the group; no copy is rendered.
    const templateCard = screen.getByRole('button', { name: /^pr-pipeline\s*Succeeded/ })
    expect(screen.getByText('morning-briefing')).toBeInTheDocument()
    expect(templateCard.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(/pr-pipeline-roundtable-/)).toBeNull()
    expect(runCalls()).toEqual([])
  })

  it('expands to the newest runs and loads more on demand', async () => {
    mockFleet()
    renderPage('/chains')
    await userEvent.click(await screen.findByRole('button', { name: /^pr-pipeline: 150 runs/ }))
    expect(groupRow()).toHaveAttribute('aria-expanded', 'true')
    const region = screen.getByRole('region', { name: 'runs of pr-pipeline' })
    await within(region).findByText('pr-pipeline-roundtable-0')
    expect(within(region).getAllByText(/^pr-pipeline-roundtable-\d+$/)).toHaveLength(GROUP_PAGE_SIZE)
    expect(runCalls()).toEqual([`/api/chains?template=pr-pipeline&offset=0&limit=${GROUP_PAGE_SIZE}`])

    await userEvent.click(within(region).getByRole('button', { name: 'Load more (130 more)' }))
    await within(region).findByText('pr-pipeline-roundtable-39')
    expect(within(region).getAllByText(/^pr-pipeline-roundtable-\d+$/)).toHaveLength(2 * GROUP_PAGE_SIZE)
    expect(runCalls()[1]).toBe(`/api/chains?template=pr-pipeline&offset=${GROUP_PAGE_SIZE}&limit=${GROUP_PAGE_SIZE}`)
    expect(within(region).getByRole('button', { name: 'Load more (110 more)' })).toBeInTheDocument()

    // Collapsing hides the runs again.
    await userEvent.click(groupRow())
    expect(within(region).queryByText('pr-pipeline-roundtable-0')).toBeNull()
  }, 20_000)

  it('fetches step results only when a chain is expanded', async () => {
    const full = { ...prPipelineChain(), name: 'pr-pipeline-roundtable-0', runTemplate: 'pr-pipeline' }
    mockFleet({ details: { 'pr-pipeline-roundtable-0': full } })
    renderPage('/chains')
    await userEvent.click(await screen.findByRole('button', { name: /^pr-pipeline: 150 runs/ }))
    const card = await screen.findByRole('button', { name: /^pr-pipeline-roundtable-0(?!\d)/ })
    expect(mockApiGet.mock.calls.some(c => c[0] === '/api/chains/pr-pipeline-roundtable-0')).toBe(false)

    await userEvent.click(card)
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledWith('/api/chains/pr-pipeline-roundtable-0', expect.anything()))
    const step = await screen.findByRole('region', { name: 'step review-fix' })
    expect(step).toHaveTextContent('round 2/5')
    const buttons = screen.getAllByRole('button').filter(b => b.textContent?.trim().endsWith('implement'))
    await userEvent.click(buttons[buttons.length - 1])
    expect(screen.getByText('PR #1')).toBeInTheDocument()
  })

  it('shows an error when the chain detail cannot be loaded', async () => {
    mockFleet()
    renderPage('/chains')
    await userEvent.click(await screen.findByRole('button', { name: /^morning-briefing/ }))
    expect(await screen.findByText(/Failed to load chain: not found/)).toBeInTheDocument()
  })

  it('opens the group of a deep-linked run copy with that run expanded', async () => {
    const full = { ...prPipelineChain(), name: 'pr-pipeline-roundtable-140', runTemplate: 'pr-pipeline' }
    mockFleet({ details: { 'pr-pipeline-roundtable-140': full } })
    renderPage('/chains?chain=pr-pipeline-roundtable-140')
    await waitFor(() => expect(groupRow()).toHaveAttribute('aria-expanded', 'true'))
    // Not in the first page of runs, but shown (and expanded) anyway.
    const region = screen.getByRole('region', { name: 'runs of pr-pipeline' })
    await within(region).findByText('pr-pipeline-roundtable-0')
    expect(within(region).getByText('pr-pipeline-roundtable-140')).toBeInTheDocument()
    expect(await within(region).findByRole('region', { name: 'step review-fix' })).toHaveTextContent('round 2/5')
  })

  it('applies live updates of run copies to their group, not the top-level list, and refreshes the counts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockFleet({ copies: [copy(0), copy(1)] })
    renderPage('/chains')
    await userEvent.click(await screen.findByRole('button', { name: /^pr-pipeline: 150 runs/ }))
    const region = screen.getByRole('region', { name: 'runs of pr-pipeline' })
    await within(region).findByText('pr-pipeline-roundtable-1')
    const groupCalls = () => mockApiGet.mock.calls.filter(c => c[0] === CHAIN_GROUPS_URL).length
    const before = groupCalls()

    emitChain({ ...prPipelineChain(), name: 'pr-pipeline-roundtable-new', runTemplate: 'pr-pipeline', phase: 'Running' })
    const names = within(region).getAllByText(/^pr-pipeline-roundtable-/).map(e => e.textContent)
    expect(names).toEqual(['pr-pipeline-roundtable-new', 'pr-pipeline-roundtable-0', 'pr-pipeline-roundtable-1'])
    // Not added to the top-level list.
    expect(screen.getAllByText('pr-pipeline-roundtable-new')).toHaveLength(1)

    emitChain({ name: 'pr-pipeline-roundtable-0', namespace: 'roundtable' }, 'delete')
    expect(within(region).queryByText('pr-pipeline-roundtable-0')).toBeNull()

    // Group counts are refreshed once for the burst.
    expect(groupCalls()).toBe(before)
    await act(async () => { vi.advanceTimersByTime(GROUP_REFRESH_MS) })
    expect(groupCalls()).toBe(before + 1)
    expect(listCalls()).toBe(1)
  })
})

describe('ChainsPage table filter', () => {
  it('asks for one table and ignores live chains of other tables', async () => {
    mockApiGet.mockImplementation((url: string) => {
      if (url === `${CHAINS_LIST_URL}&table=personal`) return Promise.resolve([{ ...fanOutChain(), name: 'mine', table: 'personal' }])
      return Promise.reject(new Error('no KV'))
    })
    renderPage('/chains?table=personal')
    expect(await screen.findByText('mine')).toBeInTheDocument()
    expect(mockApiGet.mock.calls.some(c => c[0] === `${CHAINS_LIST_URL}&table=personal`)).toBe(true)
    emitChain({ ...prPipelineChain(), name: 'theirs', table: 'roundtable-dev' })
    expect(screen.queryByText('theirs')).toBeNull()
  })
})

describe('ChainsPage cancel run', () => {
  const runCopy = (phase: string): Chain => ({ ...prPipelineChain(), name: 'pr-pipeline-roundtable-9', runTemplate: 'pr-pipeline', phase })

  function open(chain: Chain) {
    mockApiGet.mockImplementation((url: string) => {
      if (url === CHAINS_LIST_URL) return Promise.resolve([chain])
      return Promise.reject(new Error('no KV'))
    })
    renderPage(`/chains?chain=${chain.name}`)
  }

  it('shows the button only on a running run copy', async () => {
    open(runCopy('Running'))
    expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeTruthy()
  })

  it.each(['Succeeded', 'Failed'])('hides the button on a %s run copy', async (phase) => {
    open(runCopy(phase))
    await screen.findAllByText('pr-pipeline-roundtable-9')
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull()
  })

  it('hides the button on a running template', async () => {
    open({ ...prPipelineChain(), name: 'pr-pipeline', phase: 'Running' })
    await screen.findAllByText('pr-pipeline')
    expect(screen.queryByRole('button', { name: 'Cancel run' })).toBeNull()
  })

  it('calls the cancel endpoint after confirming and shows the gateway message on failure', async () => {
    const mockPost = vi.mocked(apiPost)
    mockPost.mockReset()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mockPost.mockRejectedValueOnce(new Error('run already finished'))
    open(runCopy('Running'))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }))
    expect(confirm).toHaveBeenCalled()
    expect(mockPost).toHaveBeenCalledWith('/api/chains/runs/roundtable/pr-pipeline-roundtable-9/cancel', {})
    expect((await screen.findByRole('alert')).textContent).toContain('run already finished')
    confirm.mockReturnValue(false)
    mockPost.mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel run' }))
    expect(mockPost).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('shows "Cancel requested" and disables the button after a successful cancel', async () => {
    const mockPost = vi.mocked(apiPost)
    mockPost.mockReset()
    mockPost.mockResolvedValue({})
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    open(runCopy('Running'))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Cancel requested')
    expect(screen.getByRole('button', { name: 'Cancel run' })).toBeDisabled()
    confirm.mockRestore()
  })
})

describe('ChainsPage detail refetch', () => {
  it('does not refetch /api/chains/{name} on a poll while phase and step are unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    connected = false
    const slim = (): Chain => ({ ...prPipelineChain(), slim: true, steps: [] })
    const detailCalls = () => mockApiGet.mock.calls.filter(c => String(c[0]).startsWith('/api/chains/pr-pipeline')).length
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([slim()])
        : url.startsWith('/api/chains/pr-pipeline') ? Promise.resolve(prPipelineChain())
        : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=pr-pipeline')
    // One fetch for the ?chain= focus, one for the expanded slim card.
    await waitFor(() => expect(detailCalls()).toBe(2))
    await act(async () => { vi.advanceTimersByTime(FALLBACK_POLL_MS) })
    await waitFor(() => expect(listCalls()).toBe(2))
    expect(detailCalls()).toBe(2)
  })
})

describe('ChainsPage schedule', () => {
  it('shows the Scheduled badge and schedule summary', async () => {
    const next = new Date(Date.now() + 3 * 3600_000).toISOString()
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL
        ? Promise.resolve([{ ...fanOutChain(), name: 'nightly', schedule: '0 6 * * *', timeZone: 'UTC', nextScheduledAt: next }, prPipelineChain()])
        : Promise.reject(new Error('no KV')))
    renderPage('/chains')
    const badge = await screen.findByTestId('scheduled-badge')
    expect(badge).toHaveTextContent('Scheduled')
    expect(screen.getByTestId('schedule-summary')).toHaveTextContent(/^next in 3h/)
    expect(screen.getAllByTestId('scheduled-badge')).toHaveLength(1)
  })
})

describe('ChainsPage trace link', () => {
  const id = '0af7651916cd43dd8448eb211c80319c'
  const withConfig = (traceId?: string) =>
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([{ ...fanOutChain(), traceId }, prPipelineChain()])
        : url === '/api/config' ? Promise.resolve({ traceUrlTemplate: 'https://t.example/trace/{traceId}' })
        : Promise.reject(new Error('no KV')))

  it('links the expanded chain run to its trace', async () => {
    withConfig(id)
    renderPage('/chains?chain=doc-sweep')
    const a = await screen.findByRole('link', { name: /View trace/ })
    expect(a).toHaveAttribute('href', `https://t.example/trace/${id}`)
    expect(a).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('shows no link when the chain has no trace id', async () => {
    withConfig(undefined)
    renderPage('/chains?chain=doc-sweep')
    await screen.findByRole('region', { name: 'step review-each' })
    expect(screen.queryByRole('link', { name: /View trace/ })).toBeNull()
  })
})

describe('ChainsPage timeline toggle', () => {
  it('hides the timeline until Timeline is opened', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve([fanOutChain(), prPipelineChain()]) : Promise.reject(new Error('no KV')))
    renderPage('/chains?chain=doc-sweep')
    const toggle = await screen.findByRole('button', { name: 'Timeline' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('list', { name: 'Chain run timeline' })).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('list', { name: 'Chain run timeline' })).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.queryByRole('list', { name: 'Chain run timeline' })).toBeNull()
  })
})

describe('ChainsPage truncated list', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...fanOutChain(), name: `c-${i}` }))

  const listCalls = () => mockApiGet.mock.calls.filter(c => String(c[0]).startsWith('/api/chains?')).length
    + vi.mocked(apiGetWithTotal).mock.calls.length

  it('says "showing 500 of N" from the list response, with one request', async () => {
    mockApiGet.mockImplementation(() => Promise.reject(new Error('no KV')))
    vi.mocked(apiGetWithTotal).mockReset().mockImplementation(() => Promise.resolve({ items: many(500) as never, total: 731 }))
    vi.mocked(apiFetch).mockClear()
    renderPage('/chains')
    expect(await screen.findByTestId('chains-truncated')).toHaveTextContent('showing 500 of 731')
    expect(vi.mocked(apiGetWithTotal)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled()
    expect(listCalls()).toBe(1)
  })

  it('does not show the previous table total after a table switch', async () => {
    mockApiGet.mockImplementation(() => Promise.reject(new Error('no KV')))
    vi.mocked(apiGetWithTotal).mockReset()
    let release: (v: { items: never; total: number | null }) => void = () => {}
    vi.mocked(apiGetWithTotal).mockImplementation((url: string) =>
      url.includes('table=b')
        ? new Promise(r => { release = r as typeof release })
        : Promise.resolve({ items: many(500) as never, total: 731 }))
    const { unmount } = renderPage('/chains')
    expect(await screen.findByTestId('chains-truncated')).toHaveTextContent('showing 500 of 731')
    unmount()
    vi.mocked(apiGetWithTotal).mockClear()
    renderPage('/chains?table=b')
    await waitFor(() => expect(vi.mocked(apiGetWithTotal)).toHaveBeenCalled())
    expect(screen.queryByTestId('chains-truncated')).toBeNull()
    release({ items: many(500) as never, total: 900 })
    expect(await screen.findByTestId('chains-truncated')).toHaveTextContent('showing 500 of 900')
  })

  it('shows no note when the page is not full', async () => {
    mockApiGet.mockImplementation((url: string) =>
      url === CHAINS_LIST_URL ? Promise.resolve(many(3)) : Promise.reject(new Error('no KV')))
    vi.mocked(apiGetWithTotal).mockReset().mockImplementation((url: string) =>
      mockApiGet(url).then((items: unknown) => ({ items: items as never, total: null })))
    renderPage('/chains')
    await screen.findByText('c-0')
    expect(screen.queryByTestId('chains-truncated')).toBeNull()
  })
})
