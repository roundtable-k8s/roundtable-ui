import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { DashboardPage } from './Dashboard'
import { useFleet } from '../hooks/useFleet'
import { apiGet, apiFetch } from '../lib/api'
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
let defaults: { apiGet: unknown; apiFetch: unknown; useFleet: unknown; useWebSocket: unknown }
beforeEach(() => {
  defaults = {
    apiGet: vi.mocked(apiGet).getMockImplementation(),
    apiFetch: vi.mocked(apiFetch).getMockImplementation(),
    useFleet: vi.mocked(useFleet).getMockImplementation(),
    useWebSocket: vi.mocked(useWebSocket).getMockImplementation(),
  }
})
afterEach(() => {
  vi.mocked(apiGet).mockReset().mockImplementation(defaults.apiGet as typeof apiGet)
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

  it('displays time range selector', async () => {
    renderDashboard({ defaultCostExpanded: true })
    await waitFor(() => {
      expect(screen.getByText('Week')).toBeInTheDocument()
    })
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

describe('DashboardPage truncated chain list', () => {
  async function withChains(n: number, total: string) {
    const orig = defaults.apiGet as typeof apiGet
    vi.mocked(apiGet).mockImplementation(((url: string, init?: RequestInit) =>
      url === '/api/chains?limit=500'
        ? Promise.resolve(Array.from({ length: n }, (_, i) => ({ name: `c-${i}`, phase: 'Succeeded', steps: [] })))
        : orig(url, init)) as typeof apiGet)
    vi.mocked(apiFetch).mockImplementation(((url: string) =>
      url === '/api/chains?limit=1'
        ? Promise.resolve(new Response('[]', { headers: { 'X-Total-Count': total } }))
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) })) as typeof apiFetch)
  }

  it('says "showing 500 of N" when there are more chains than the page', async () => {
    await withChains(500, '731')
    renderDashboard()
    expect(await screen.findByTestId('chains-truncated')).toHaveTextContent('showing 500 of 731')
  })

  it('shows no note with fewer than 500 chains', async () => {
    await withChains(2, '2')
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
    vi.mocked(useFleet).mockReturnValueOnce({ knights: [], loading: true, error: null, refresh: vi.fn() } as never)
    renderDashboard()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})

describe('DashboardPage scheduled chains', () => {
  it('shows "next in" for a scheduled chain that is not suspended', async () => {
    const orig = vi.mocked(apiGet).getMockImplementation()!
    const next = new Date(Date.now() + 3 * 3600_000).toISOString()
    vi.mocked(apiGet).mockImplementation(((url: string, init?: RequestInit) =>
      url === '/api/chains?limit=500'
        ? Promise.resolve([
          { name: 'nightly', phase: 'Succeeded', schedule: '0 6 * * *', nextScheduledAt: next, steps: [] },
          { name: 'paused', phase: 'Succeeded', schedule: '0 6 * * *', suspend: true, nextScheduledAt: next, steps: [] },
        ])
        : orig(url, init)) as typeof apiGet)
    renderDashboard()
    expect(await screen.findByText(/^next in 3h/)).toBeInTheDocument()
    expect(screen.getAllByText(/^next in/)).toHaveLength(1)
    vi.mocked(apiGet).mockImplementation(orig)
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
