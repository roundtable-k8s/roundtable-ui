import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { BrowserRouter } from 'react-router-dom'
import { DashboardPage } from './Dashboard'
import { useFleet } from '../hooks/useFleet'

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
    const orig = vi.mocked(useFleet).getMockImplementation()!
    vi.mocked(useFleet).mockImplementation(() => fleetOf(['rt-lead', 'merlin']))
    renderDashboard()
    expect(screen.getByText('merlin')).toBeInTheDocument()
    expect(screen.getByText('rt-lead')).toBeInTheDocument()
    expect(screen.getAllByText('online').length).toBe(2)
    expect(screen.queryByText('galahad')).not.toBeInTheDocument()
    vi.mocked(useFleet).mockImplementation(orig)
  })

  it('shows an empty state, not offline tiles, for an empty fleet', () => {
    const orig = vi.mocked(useFleet).getMockImplementation()!
    vi.mocked(useFleet).mockImplementation(() => fleetOf([]))
    renderDashboard()
    expect(screen.getByText('No knights found')).toBeInTheDocument()
    expect(screen.queryByText('offline')).not.toBeInTheDocument()
    expect(screen.queryByText('galahad')).not.toBeInTheDocument()
    vi.mocked(useFleet).mockImplementation(orig)
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
    const { useWebSocket } = await import('../hooks/useWebSocket')
    const { apiFetch } = await import('../lib/api')
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
    const { useWebSocket } = await import('../hooks/useWebSocket')
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
    const { apiGet, apiFetch } = await import('../lib/api')
    const orig = vi.mocked(apiGet).getMockImplementation()!
    vi.mocked(apiGet).mockImplementation(((url: string, init?: RequestInit) =>
      url === '/api/chains?limit=500'
        ? Promise.resolve(Array.from({ length: n }, (_, i) => ({ name: `c-${i}`, phase: 'Succeeded', steps: [] })))
        : orig(url, init)) as typeof apiGet)
    vi.mocked(apiFetch).mockImplementation(((url: string) =>
      url === '/api/chains?limit=1'
        ? Promise.resolve(new Response('[]', { headers: { 'X-Total-Count': total } }))
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) })) as typeof apiFetch)
    return () => vi.mocked(apiGet).mockImplementation(orig)
  }

  it('says "showing 500 of N" when there are more chains than the page', async () => {
    const restore = await withChains(500, '731')
    renderDashboard()
    expect(await screen.findByTestId('chains-truncated')).toHaveTextContent('showing 500 of 731')
    restore()
  })

  it('shows no note with fewer than 500 chains', async () => {
    const restore = await withChains(2, '2')
    renderDashboard()
    await screen.findByText('c-0')
    expect(screen.queryByTestId('chains-truncated')).toBeNull()
    restore()
  })
})
