import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { DashboardPage } from './Dashboard'
import { useFleet } from '../hooks/useFleet'
import { apiGet, apiGetWithTotal, apiFetch } from '../lib/api'
import { useWebSocket } from '../hooks/useWebSocket'

// Mock the hooks
vi.mock('../hooks/useFleet', () => ({
  useFleet: vi.fn(() => ({
    knights: [
      {
        name: 'galahad',
        domain: 'security',
        status: 'online',
        ready: true,
        restarts: 0,
        age: '2h',
        image: 'knight:latest',
        skills: 5,
        nixTools: 10,
        labels: {},
        phase: 'Ready',
      },
      {
        name: 'lancelot',
        domain: 'frontend',
        status: 'online',
        ready: true,
        restarts: 0,
        age: '1h',
        image: 'knight:latest',
        skills: 3,
        nixTools: 5,
        labels: {},
        phase: 'Ready',
      },
    ],
    loading: false,
    error: null,
  })),
}))

vi.mock('../hooks/useWebSocket', () => ({
  eventKey: (e: { subject: string; timestamp: string }) => `${e.subject}:${e.timestamp}`,
  useWebSocket: vi.fn(() => ({
    events: [],
    connected: true,
  })),
}))

const runningState = vi.hoisted(() => ({
  current: { tasks: new Map(), loading: false, error: null as string | null, unavailable: false },
}))
vi.mock('../hooks/useRunning', () => ({ useRunning: () => runningState.current }))

vi.mock('../lib/api', () => ({
  apiGet: vi.fn((url: string) => {
    if (url === '/api/chains?limit=500') {
      return Promise.resolve([
        {
          name: 'test-chain',
          phase: 'Running',
          startTime: new Date().toISOString(),
          steps: [],
        },
      ])
    }
    if (url === '/api/fleet') {
      return Promise.resolve([
        { name: 'galahad' },
        { name: 'lancelot' },
      ])
    }
    return Promise.resolve({})
  }),
  apiGetWithTotal: vi.fn(async (url: string, init?: unknown) => {
    const { apiGet } = await import('../lib/api')
    return { items: await apiGet(url, init as never), total: null }
  }),
  // fetchWithTimeout (session introspection) goes through apiFetch — report
  // "unsupported" so cost fan-out resolves without network access
  apiFetch: vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })),
}))

function renderDashboard(props = {}) {
  return render(
    <BrowserRouter>
      <DashboardPage {...props} />
    </BrowserRouter>
  )
}

// Tests override these mocks; put the defaults back after every test, pass or fail.
let defaults: { apiGetWithTotal: unknown; apiGet: unknown; apiFetch: unknown; useFleet: unknown; useWebSocket: unknown }
beforeEach(() => {
  defaults = {
    apiGetWithTotal: vi.mocked(apiGetWithTotal).getMockImplementation(),
    apiGet: vi.mocked(apiGet).getMockImplementation(),
    apiFetch: vi.mocked(apiFetch).getMockImplementation(),
    useFleet: vi.mocked(useFleet).getMockImplementation(),
    useWebSocket: vi.mocked(useWebSocket).getMockImplementation(),
  }
})
afterEach(() => {
  vi.mocked(apiGet).mockReset().mockImplementation(defaults.apiGet as typeof apiGet)
  vi.mocked(apiGetWithTotal).mockReset().mockImplementation(defaults.apiGetWithTotal as typeof apiGetWithTotal)
  vi.mocked(apiFetch).mockReset().mockImplementation(defaults.apiFetch as typeof apiFetch)
  vi.mocked(useFleet).mockReset().mockImplementation(defaults.useFleet as typeof useFleet)
  vi.mocked(useWebSocket).mockReset().mockImplementation(defaults.useWebSocket as typeof useWebSocket)
})

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the dashboard title', () => {
    renderDashboard()
    expect(screen.getByText('Command Center')).toBeInTheDocument()
  })

  it('displays fleet status section', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText(/Fleet Status/i)).toBeInTheDocument()
    })
  })

  it('shows online knight count', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText('2/2')).toBeInTheDocument() // 2 of 2 knights online
    })
  })

  it('displays cost panel toggle', async () => {
    renderDashboard()
    await waitFor(() => {
      // Look for cost-related text
      const costElements = screen.queryAllByText(/cost/i)
      expect(costElements.length).toBeGreaterThan(0)
    })
  })

  it('cost panel is collapsed by default', () => {
    renderDashboard()
    // Panel should be collapsed, so detailed breakdown not visible initially
    const costPanel = screen.queryByText(/Per-Knight Breakdown/i)
    // If collapsed, this may not be in the document
    expect(costPanel).not.toBeInTheDocument()
  })

  it('cost panel is expanded when defaultCostExpanded is true', async () => {
    renderDashboard({ defaultCostExpanded: true })
    await waitFor(() => {
      expect(screen.getByText(/Daily Cost Trend/i)).toBeInTheDocument()
    })
  })

  it('toggles cost panel when clicked', async () => {
    const user = userEvent.setup()
    renderDashboard()

    // Find and click the cost panel toggle button
    const costButton = screen.getByRole('button', { name: /Cost Details/i })

    // Initially collapsed
    expect(screen.queryByText(/Daily Cost Trend/i)).not.toBeInTheDocument()

    // Click to expand
    await user.click(costButton)

    await waitFor(() => {
      expect(screen.getByText(/Daily Cost Trend/i)).toBeInTheDocument()
    })

    // Click to collapse
    await user.click(costButton)

    await waitFor(() => {
      expect(screen.queryByText(/Daily Cost Trend/i)).not.toBeInTheDocument()
    })
  })

  it('displays activity feed section', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByText(/Recent Activity/i)).toBeInTheDocument()
    })
  })

  it('shows recent chains section', async () => {
    renderDashboard()
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Chains/i })).toBeInTheDocument()
    })
  })

  it('displays WebSocket connection status', async () => {
    renderDashboard()
    await waitFor(() => {
      // Connected status indicator in the header
      expect(screen.queryAllByText(/live/i).length).toBeGreaterThan(0)
    })
  })

  it('renders fleet link', () => {
    renderDashboard()
    const links = screen.getAllByRole('link', { name: /View all/i })
    expect(links.some(l => l.getAttribute('href') === '/fleet')).toBe(true)
  })

  it('shows the running-task count linking to the Running page', () => {
    const t = (taskId: string, status: string) => [taskId, { taskId, knight: 'galahad', status, startedAt: '' }] as const
    runningState.current = { ...runningState.current, tasks: new Map([t('a', 'running'), t('b', 'running'), t('c', 'stale'), t('d', 'lost')]) }
    renderDashboard()
    const card = screen.getByRole('link', { name: 'Running tasks' })
    expect(card).toHaveAttribute('href', '/running')
    expect(card).toHaveTextContent('Running Tasks4')
    expect(card).toHaveTextContent('1 stale • 1 lost')
    runningState.current = { ...runningState.current, tasks: new Map() }
  })

  it('renders chains link', () => {
    renderDashboard()
    const links = screen.getAllByRole('link', { name: /View all/i })
    expect(links.some(l => l.getAttribute('href') === '/chains')).toBe(true)
  })

  it('handles empty fleet gracefully', () => {
    vi.mocked(useFleet).mockReturnValueOnce({
      knights: [],
      loading: false,
      error: null,
    } as unknown as ReturnType<typeof useFleet>)

    renderDashboard()
    expect(screen.getByText('Command Center')).toBeInTheDocument()
  })

  const fleetOf = (names: string[]) => ({
    knights: names.map(name => ({
      name, domain: 'x', status: 'online', ready: true, restarts: 0, age: '1h',
      image: '', skills: 0, nixTools: 0, labels: {}, phase: 'Ready',
    })),
    loading: false,
    error: null,
  }) as unknown as ReturnType<typeof useFleet>

  it('lists fleet knights that are not in KNIGHT_CONFIG', () => {
    vi.mocked(useFleet).mockImplementation(() => fleetOf(['rt-lead', 'merlin']))
    renderDashboard()
    expect(screen.getByText('merlin')).toBeInTheDocument()
    expect(screen.getByText('rt-lead')).toBeInTheDocument()
    expect(screen.getAllByText('online').length).toBe(2)
    expect(screen.queryByText('galahad')).not.toBeInTheDocument()
  })

  it('shows an empty state, not offline tiles, for an empty fleet', () => {
    vi.mocked(useFleet).mockImplementation(() => fleetOf([]))
    renderDashboard()
    expect(screen.getByRole('heading', { name: 'No knights yet' })).toBeInTheDocument()
    expect(screen.queryByText('offline')).not.toBeInTheDocument()
    expect(screen.queryByText('galahad')).not.toBeInTheDocument()
  })

  it('puts the date-range selector on the chain cost table only', async () => {
    renderDashboard({ defaultCostExpanded: true })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Last 7 days' })).toBeInTheDocument()
    })
  })

  it('labels event-derived cost figures by the buffer span, never as days (#661)', async () => {
    const ts = new Date(Date.now() - 2 * 3600_000).toISOString()
    const events = [{
      type: 'result' as const, subject: 'fleet.results.t-1', timestamp: ts, live: true,
      data: { knight: 'galahad', cost: 0.5, success: true, task_id: 't-1' },
    }]
    vi.mocked(useWebSocket).mockReturnValue({ events, connected: true } as unknown as ReturnType<typeof useWebSocket>)
    renderDashboard({ defaultCostExpanded: true })
    const toggle = screen.getByRole('button', { name: /Cost Details/i })
    expect(toggle).toHaveTextContent(/last 1 events, since/)
    expect(toggle).not.toHaveTextContent(/days?\b|24h/i)
    expect(screen.getByTestId('cost-coverage')).toHaveTextContent(/last 1 events, since/)
    expect(screen.getByTestId('cost-coverage')).not.toHaveTextContent(/days/)
  })
})

describe('DashboardPage session cost refresh (#152)', () => {
  const result = (knight: string, ts: string, cost: number) => ({
    type: 'result' as const,
    subject: `fleet.results.t-${ts}`,
    timestamp: ts,
    live: true,
    data: { knight, cost, success: true, task_id: `t-${ts}` },
  })

  async function setup(events: unknown[], sessionCost: () => number) {
    vi.mocked(apiFetch).mockImplementation(((url: string) => {
      const m = /fleet\/(\w+)\/session/.exec(url)
      // Only galahad has session stats
      if (m?.[1] === 'galahad') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ session: { cost: sessionCost() } }) })
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
    }) as unknown as typeof apiFetch)
    const ws = vi.mocked(useWebSocket)
    ws.mockReturnValue({ events: [], connected: true } as unknown as ReturnType<typeof useWebSocket>)
    const view = renderDashboard()
    await waitFor(() => expect(screen.getAllByText('$1.00').length).toBeGreaterThan(0))
    ws.mockReturnValue({ events, connected: true } as unknown as ReturnType<typeof useWebSocket>)
    return { view, apiFetch }
  }

  it('refreshes (debounced) session cost for a knight with session stats, without double-counting', async () => {
    let cost = 1
    const evs = [result('galahad', '2026-01-01T00:00:02Z', 0.5), result('galahad', '2026-01-01T00:00:01Z', 0.5)]
    const { view, apiFetch } = await setup(evs, () => cost)
    const before = vi.mocked(apiFetch).mock.calls.length
    cost = 2
    view.rerender(<BrowserRouter><DashboardPage /></BrowserRouter>)
    await waitFor(() => expect(screen.getAllByText('$2.00').length).toBeGreaterThan(0), { timeout: 4000 })
    // Two results in a burst => a single coalesced fetch; live costs not added on top
    expect(vi.mocked(apiFetch).mock.calls.length - before).toBe(1)
    expect(screen.queryByText('$3.00')).not.toBeInTheDocument()
  })

  it('backfills live cost for a knight without session stats and does not fetch', async () => {
    const { view, apiFetch } = await setup([], () => 1)
    const before = vi.mocked(apiFetch).mock.calls.length
    vi.mocked(useWebSocket).mockReturnValue({
      events: [result('lancelot', '2026-01-01T00:00:03Z', 0.25)], connected: true,
    } as unknown as ReturnType<typeof useWebSocket>)
    view.rerender(<BrowserRouter><DashboardPage /></BrowserRouter>)
    await waitFor(() => expect(screen.getAllByText('$1.25').length).toBeGreaterThan(0))
    await new Promise(r => setTimeout(r, 2300))
    expect(vi.mocked(apiFetch).mock.calls.length).toBe(before)
  })
})

describe('DashboardPage session cost follows the fleet (#645)', () => {
  const fleet = (names: string[]) => ({
    knights: names.map(name => ({
      name, domain: 'x', status: 'online', ready: true, restarts: 0, age: '1h',
      image: '', skills: 0, nixTools: 0, labels: {}, phase: 'Ready',
    })),
    loading: false,
    error: null,
  }) as unknown as ReturnType<typeof useFleet>
  const sessionCalls = () => vi.mocked(apiFetch).mock.calls.filter(c => /session/.test(String(c[0])))
  const costs: Record<string, number> = { a: 1, b: 2 }
  beforeEach(() => {
    vi.mocked(apiFetch).mockImplementation(((url: string) => {
      const m = /fleet\/(\w+)\/session/.exec(url)
      const c = m ? costs[m[1]] : undefined
      return Promise.resolve({ ok: !!c, json: () => Promise.resolve({ session: { cost: c } }) })
    }) as unknown as typeof apiFetch)
  })

  it('fetches and counts a knight that appears after the first poll', async () => {
    vi.mocked(useFleet).mockImplementation(() => fleet(['a']))
    const view = renderDashboard()
    await waitFor(() => expect(screen.getAllByText('$1.00').length).toBeGreaterThan(0))
    expect(sessionCalls().length).toBe(1)
    vi.mocked(useFleet).mockImplementation(() => fleet(['a', 'b']))
    view.rerender(<BrowserRouter><DashboardPage /></BrowserRouter>)
    await waitFor(() => expect(screen.getAllByText('$3.00').length).toBeGreaterThan(0))
    expect(sessionCalls().length).toBe(2)
  })

  it('drops knights of another table when the fleet list changes', async () => {
    vi.mocked(useFleet).mockImplementation(() => fleet(['a', 'b']))
    const view = renderDashboard()
    await waitFor(() => expect(screen.getAllByText('$3.00').length).toBeGreaterThan(0))
    vi.mocked(useFleet).mockImplementation(() => fleet(['b']))
    view.rerender(<BrowserRouter><DashboardPage /></BrowserRouter>)
    await waitFor(() => expect(screen.queryByText('$3.00')).not.toBeInTheDocument())
    expect(screen.getAllByText('$2.00').length).toBeGreaterThan(0)
    expect(sessionCalls().length).toBe(2)
  })
})

describe('DashboardPage daily trend order (#645)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('is chronological across New Year', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 0, 2, 12) })
    const at = (y: number, m: number, d: number, cost: number) => {
      const ts = new Date(y, m, d, 12).toISOString()
      return { type: 'result' as const, subject: `fleet.results.${ts}`, timestamp: ts, live: false, data: { knight: 'galahad', cost, success: true, task_id: ts } }
    }
    // newest first, as the gateway delivers them
    vi.mocked(useWebSocket).mockReturnValue({
      events: [at(2026, 0, 1, 3), at(2025, 11, 31, 2), at(2025, 11, 30, 1)], connected: true,
    } as unknown as ReturnType<typeof useWebSocket>)
    renderDashboard({ defaultCostExpanded: true })
    const heading = await screen.findByText(/Daily Cost Trend/i)
    const panel = heading.closest('div')!.parentElement!
    const costs = [...panel.querySelectorAll('.text-roundtable-gold.font-medium')].map(e => e.textContent)
    expect(costs.slice(-3)).toEqual(['$1.00', '$2.00', '$3.00'])
  })
})

describe('DashboardPage truncated chain list', () => {
  async function withChains(n: number, total: number | null) {
    vi.mocked(apiGetWithTotal).mockImplementation((async (url: string) =>
      url === '/api/chains?limit=500'
        ? { items: Array.from({ length: n }, (_, i) => ({ name: `c-${i}`, phase: 'Succeeded', steps: [] })), total }
        : { items: [], total: null }) as never)
  }

  it('says "showing 500 of N" when there are more chains than the page', async () => {
    await withChains(500, 731)
    renderDashboard()
    expect(await screen.findByTestId('chains-truncated')).toHaveTextContent('showing 500 of 731')
    // one list request, no second limit=1 call
    expect(vi.mocked(apiGetWithTotal)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(apiFetch).mock.calls.some(c => String(c[0]).includes('limit=1'))).toBe(false)
  })

  it('shows no note with fewer than 500 chains', async () => {
    await withChains(2, 2)
    renderDashboard()
    await screen.findByText('c-0')
    expect(screen.queryByTestId('chains-truncated')).toBeNull()
  })

  it('shows fleet and chain failures instead of zeros', async () => {
    vi.mocked(useFleet).mockReturnValueOnce({ knights: [], loading: false, error: 'HTTP 500', refresh: vi.fn() } as never)
    vi.mocked(apiGet).mockImplementation((url: string) =>
      url.startsWith('/api/chains') ? Promise.reject(new Error('gateway down')) : Promise.resolve({}))
    renderDashboard()
    expect(screen.getByText(/Failed to load fleet: HTTP 500/)).toBeInTheDocument()
    expect(await screen.findByText(/Failed to load chains: gateway down/)).toBeInTheDocument()
  })

  it('shows a spinner while the first load is pending', () => {
    vi.mocked(useFleet).mockReturnValue({ knights: [], loading: true, error: null, refresh: vi.fn() } as never)
    renderDashboard()
    expect(screen.getByText('Loading…').closest('[role="status"]')).not.toBeNull()
    expect(screen.queryByText('0/0')).not.toBeInTheDocument()
    expect(screen.getByText('…')).toBeInTheDocument()
  })

  it('shows no spinner once the fleet has loaded', async () => {
    renderDashboard()
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  })
})

describe('DashboardPage scheduled chains', () => {
  it('shows "next in" for a scheduled chain that is not suspended', async () => {
    const orig = vi.mocked(apiGet).getMockImplementation()!
    // 3.5h, not 3h: until() floors to whole hours, so a fixture exactly 3h away reads "in 2h" once a few ms pass.
    const next = new Date(Date.now() + 3.5 * 3600_000).toISOString()
    vi.mocked(apiGet).mockImplementation(((url: string, init?: RequestInit) =>
      url === '/api/chains?limit=500'
        ? Promise.resolve([
          { name: 'nightly', phase: 'Succeeded', schedule: '0 6 * * *', nextScheduledAt: next, steps: [] },
          { name: 'paused', phase: 'Succeeded', schedule: '0 6 * * *', suspend: true, nextScheduledAt: next, steps: [] },
        ])
        : orig(url, init)) as typeof apiGet)
    try {
      renderDashboard()
      expect(await screen.findByText(/^next in 3h/)).toBeInTheDocument()
      expect(screen.getAllByText(/^next in/)).toHaveLength(1)
    } finally {
      vi.mocked(apiGet).mockImplementation(orig)
    }
  })
})

describe('DashboardPage first run', () => {
  const emptyFleet = { knights: [], loading: false, error: null } as unknown as ReturnType<typeof useFleet>

  it('shows the first-run panel in the fleet panel when the fleet is empty', () => {
    vi.mocked(useFleet).mockReturnValue(emptyFleet)
    renderDashboard()
    expect(screen.getByRole('heading', { name: 'No knights yet' })).toBeInTheDocument()
    expect(screen.queryByText('No knights found')).not.toBeInTheDocument()
  })

  it('hides the first-run panel while loading', () => {
    vi.mocked(useFleet).mockReturnValue({ ...emptyFleet, loading: true } as unknown as ReturnType<typeof useFleet>)
    renderDashboard()
    expect(screen.queryByRole('heading', { name: 'No knights yet' })).not.toBeInTheDocument()
  })

  it('hides the first-run panel on a failed request and keeps the error', () => {
    vi.mocked(useFleet).mockReturnValue({ ...emptyFleet, error: 'boom' } as unknown as ReturnType<typeof useFleet>)
    renderDashboard()
    expect(screen.queryByRole('heading', { name: 'No knights yet' })).not.toBeInTheDocument()
    expect(screen.getByText('Failed to load fleet: boom')).toBeInTheDocument()
  })

  it('hides the first-run panel with one knight', () => {
    vi.mocked(useFleet).mockReturnValue({
      knights: [{ name: 'galahad', domain: 'x', status: 'online', ready: true, restarts: 0, age: '1h', image: '', skills: 0, nixTools: 0, labels: {}, phase: 'Ready' }],
      loading: false,
      error: null,
    } as unknown as ReturnType<typeof useFleet>)
    renderDashboard()
    expect(screen.queryByRole('heading', { name: 'No knights yet' })).not.toBeInTheDocument()
  })
})

describe('DashboardPage cost by chain (#515)', () => {
  function withCostChains(chains: Array<Record<string, unknown>>) {
    const orig = defaults.apiGet as typeof apiGet
    vi.mocked(apiGet).mockImplementation(((url: string, init?: RequestInit) =>
      url === '/api/chains?limit=500'
        ? Promise.resolve(chains)
        : orig(url, init)) as typeof apiGet)
  }
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

  it('shows one row per template with the summed cost and run count', async () => {
    withCostChains([
      { name: 'digest-1', runTemplate: 'digest', phase: 'Succeeded', startTime: at(30), completionTime: at(20), costUSD: '0.10', steps: [] },
      { name: 'digest-2', runTemplate: 'digest', phase: 'Succeeded', startTime: at(90), completionTime: at(80), costUSD: '0.20', steps: [] },
      { name: 'digest-3', runTemplate: 'digest', phase: 'Succeeded', startTime: at(150), completionTime: at(140), costUSD: '0.30', steps: [] },
    ])
    renderDashboard({ defaultCostExpanded: true })
    const table = await screen.findByRole('table', { name: 'Cost by chain' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('digest')).toBeInTheDocument()
    expect(within(rows[0]).getByText('3')).toBeInTheDocument()
    expect(within(rows[0]).getByText('$0.60')).toBeInTheDocument()
  })

  it('shows a dash, not $0, for a chain without cost data', async () => {
    withCostChains([
      { name: 'quiet', phase: 'Succeeded', startTime: at(10), completionTime: at(5), steps: [] },
    ])
    renderDashboard({ defaultCostExpanded: true })
    const table = await screen.findByRole('table', { name: 'Cost by chain' })
    const row = within(table).getAllByRole('row')[1]
    expect(within(row).getByText('—')).toBeInTheDocument()
    expect(within(row).queryByText('$0.00')).toBeNull()
  })

  it('marks the notional part of a chain cost', async () => {
    withCostChains([
      { name: 'sub', phase: 'Succeeded', startTime: at(10), completionTime: at(5), costUSD: '0.50', notionalCostUSD: '0.50', steps: [] },
    ])
    renderDashboard({ defaultCostExpanded: true })
    const table = await screen.findByRole('table', { name: 'Cost by chain' })
    expect(within(table).getByText('notional')).toBeInTheDocument()
  })

  it('leaves out chains older than the selected range', async () => {
    withCostChains([
      { name: 'old', phase: 'Succeeded', startTime: at(60 * 24 * 10), completionTime: at(60 * 24 * 10), costUSD: '4', steps: [] },
    ])
    renderDashboard({ defaultCostExpanded: true })
    expect(await screen.findByText('No chain runs in this range')).toBeInTheDocument()
  })
})

describe('DashboardPage cost CSV download (#514)', () => {
  const result = (knight: string, taskId: string, cost: number) => ({
    type: 'result' as const,
    subject: `fleet.results.${taskId}`,
    timestamp: new Date().toISOString(),
    live: true,
    data: { knight, cost, success: true, task_id: taskId },
  })

  it('downloads the panel figures as CSV', async () => {
    const user = userEvent.setup()
    const events = [result('galahad', 't-1', 0.5), result('lancelot', 't-2', 0.25), result('=cmd', 't-3', 0.1)]
    vi.mocked(useWebSocket).mockReturnValue({ events, connected: true } as unknown as ReturnType<typeof useWebSocket>)
    const createObjectURL = vi.fn(() => 'blob:cost')
    const revokeObjectURL = vi.fn()
    const urlApi = URL as unknown as Record<string, unknown>
    urlApi.createObjectURL = createObjectURL
    urlApi.revokeObjectURL = revokeObjectURL
    const clicks: HTMLAnchorElement[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this)
    })

    try {
      renderDashboard({ defaultCostExpanded: true })
      const button = screen.getByRole('button', { name: 'Download CSV' })
      expect(screen.getByTestId('cost-coverage')).toBeInTheDocument()
      await user.click(button)

      expect(createObjectURL).toHaveBeenCalledTimes(1)
      const blob = createObjectURL.mock.calls[0][0] as Blob
      expect(blob.type).toBe('text/csv;charset=utf-8')
      const text = await blob.text()
      expect(text).toContain('Knight,Cost (USD),Tasks,Failed\r\n')
      expect(text).toContain('galahad,0.5,1,0\r\n')
      expect(text).toContain('lancelot,0.25,1,0\r\n')
      expect(text).toContain("'=cmd,0.1,1,0")
      expect(text).toContain('Top tasks\r\n')
      expect(clicks[0].download).toBe('roundtable-costs.csv')
      expect(clicks[0].href).toBe('blob:cost')
      expect(clicks[0].isConnected).toBe(false)
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:cost'))
    } finally {
      click.mockRestore()
      delete urlApi.createObjectURL
      delete urlApi.revokeObjectURL
    }
  })
})
