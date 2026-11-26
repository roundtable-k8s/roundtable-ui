import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { KnightIsolationSection, KnightDetailDrawer } from './KnightDetailDrawer'
import type { Knight } from '../hooks/useFleet'
import { isolated, notEnforced, optedOut } from '../test/fixtures/isolation'

vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  apiGet: vi.fn(() => new Promise(() => {})),
}))
vi.mock('../hooks/useKnightSession', () => ({
  useKnightSession: () => ({ stats: null, recent: [], loading: false, error: null, fetchStats: vi.fn(), fetchRecent: vi.fn() }),
}))

describe('KnightIsolationSection', () => {
  it('lists RuntimeClass, hosts, ports and services of an isolated knight', () => {
    render(<KnightIsolationSection isolation={isolated} />)
    expect(screen.getByTestId('isolation-badge')).toHaveTextContent('isolated')
    expect(screen.getByText('gvisor')).toBeInTheDocument()
    expect(screen.getByText('api.anthropic.com')).toBeInTheDocument()
    expect(screen.getByText('*.github.com')).toBeInTheDocument()
    expect(screen.getByText('443')).toBeInTheDocument()
    expect(screen.getByText('nats/nats:4222')).toBeInTheDocument()
    expect(screen.queryByTestId('hostname-warning')).not.toBeInTheDocument()
  })

  it('shows per-host ports and the empty-allowlist hint', () => {
    const egress = { ...isolated.egress!, allowedHosts: ['api.github.com', 'registry.example'], allowedHostEntries: [{ host: 'api.github.com' }, { host: 'registry.example', ports: [5000] }] }
    const { unmount } = render(<KnightIsolationSection isolation={{ ...isolated, egress }} />)
    expect(screen.getByText('api.github.com')).toBeInTheDocument()
    expect(screen.getByText('registry.example:5000')).toBeInTheDocument()
    unmount()
    render(<KnightIsolationSection isolation={{ ...isolated, egress: { ...egress, allowedHosts: [], allowedHostEntries: [] } }} />)
    expect(screen.getByText('none (DNS, NATS and the baseline only)')).toBeInTheDocument()
  })

  it('shows an opt-out with its reason and that any host is reachable', () => {
    render(<KnightIsolationSection isolation={optedOut} />)
    expect(screen.getByTestId('isolation-badge')).toHaveTextContent('opted out')
    expect(screen.getByText('Opted out (egress: unrestricted)')).toBeInTheDocument()
    expect(screen.getByText('Reason: scrapes arbitrary sites')).toBeInTheDocument()
    expect(screen.getByTestId('hostname-warning')).toHaveTextContent('may reach any host')
    expect(screen.queryByText('Allowed hosts')).not.toBeInTheDocument()
  })

  it('states plainly that hostname rules are not enforced without the Cilium API', () => {
    render(<KnightIsolationSection isolation={notEnforced} />)
    expect(screen.getByTestId('isolation-badge')).toHaveTextContent('not enforced')
    expect(screen.getByTestId('hostname-warning')).toHaveTextContent(
      'Hostname rules are not enforced: the CiliumNetworkPolicy API is unavailable',
    )
    expect(screen.getByText('pypi.org')).toBeInTheDocument()
    expect(screen.getByText('Allowlist inherited from the RoundTable default.')).toBeInTheDocument()
  })

  it('renders in the drawer from the fleet entry', () => {
    const knight: Knight = {
      name: 'kay', domain: 'research', status: 'online', ready: true, restarts: 0, age: '1h',
      image: 'knight:latest', skills: 0, nixTools: 0, labels: {}, isolation: optedOut,
    }
    render(<KnightDetailDrawer knight={knight} onClose={() => {}} />)
    const section = screen.getByTestId('knight-isolation-section')
    expect(within(section).getByText('Reason: scrapes arbitrary sites')).toBeInTheDocument()
  })
})
