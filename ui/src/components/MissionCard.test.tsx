import { describe, it, expect, vi } from 'vitest'
import { apiGet, apiDelete, ApiError } from '../lib/api'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MissionCard } from './MissionCard'
import type { Mission } from '../hooks/useMissions'

vi.mock('../lib/api', () => ({
  apiGet: vi.fn(() => Promise.reject(new Error('none'))),
  apiDelete: vi.fn(() => Promise.resolve()),
  ApiError: class ApiError extends Error {
    status: number
    constructor(status: number, message: string) { super(message); this.status = status }
  },
}))

function mission(over: Partial<Mission> = {}): Mission {
  return {
    name: 'costly', namespace: 'roundtable', phase: 'Succeeded', objective: 'spend wisely',
    startedAt: null, expiresAt: null, knights: ['lancelot', 'galahad'], chains: ['build', 'gone'],
    costBudgetUSD: '', totalCost: '0.7500', ttlSeconds: 3600, timeoutSeconds: 1800, roundTableRef: 'rt',
    ...over,
  }
}

describe('MissionCard cost', () => {
  it('shows the mission total and tokens, per-chain cost and the notional part', async () => {
    render(<MissionCard mission={mission({
      tokens: { input: 30000, output: 4500 },
      notionalCostUSD: '0.250000',
      chainStatuses: [
        { name: 'build', chainCRName: 'costly-build', phase: 'Succeeded', costUSD: '0.750000', tokens: { input: 30000, output: 4500 }, notionalCostUSD: '0.250000' },
        { name: 'gone', chainCRName: 'costly-gone', phase: 'Pending' },
      ],
    })} />)

    const total = screen.getByLabelText('mission cost')
    expect(total).toHaveTextContent('$0.75')
    expect(total).toHaveTextContent('incl. $0.25 notional')
    expect(total).toHaveTextContent('30k in / 4.5k out')

    await userEvent.click(screen.getByRole('button', { name: /Chains \(2\)/ }))
    const build = screen.getByLabelText('build cost')
    expect(build).toHaveTextContent('$0.75')
    expect(build).toHaveTextContent('incl. $0.25 notional')
    expect(build).toHaveTextContent('30k in / 4.5k out')
    const gone = screen.getByLabelText('gone cost')
    expect(gone).toHaveTextContent('—')
    expect(within(gone).queryByText(/notional/)).toBeNull()
  })

  it('marks an all-subscription mission notional', () => {
    render(<MissionCard mission={mission({ notionalCostUSD: '0.750000' })} />)
    const total = screen.getByLabelText('mission cost')
    expect(within(total).getByText('notional')).toBeInTheDocument()
    expect(within(total).getByText('$0.75').parentElement).toHaveAttribute('title', expect.stringMatching(/subscription/))
  })

  it('renders without cost data', () => {
    render(<MissionCard mission={mission({ totalCost: '' })} />)
    const total = screen.getByLabelText('mission cost')
    expect(total).toHaveTextContent('Cost—')
    expect(total).toHaveTextContent('Tokens—')
  })
})

describe('MissionCard trace link', () => {
  const id = '0af7651916cd43dd8448eb211c80319c'
  it('links to the trace when configured', async () => {
    vi.mocked(apiGet).mockImplementation((url: string) =>
      url === '/api/config' ? Promise.resolve({ traceUrlTemplate: 'https://t.example/trace/{traceId}' }) : Promise.reject(new Error('none')))
    render(<MissionCard mission={mission({ traceId: id })} />)
    expect(await screen.findByRole('link', { name: /View trace/ })).toHaveAttribute('href', `https://t.example/trace/${id}`)
  })
  it('shows no link without a trace id', async () => {
    vi.mocked(apiGet).mockImplementation((url: string) =>
      url === '/api/config' ? Promise.resolve({ traceUrlTemplate: 'https://t.example/trace/{traceId}' }) : Promise.reject(new Error('none')))
    render(<MissionCard mission={mission()} />)
    await Promise.resolve()
    expect(screen.queryByRole('link', { name: /View trace/ })).toBeNull()
  })
})

describe('MissionCard details link and timing', () => {
  it('renders view details and a pointer cursor only with onClick', () => {
    const { container, rerender } = render(<MissionCard mission={mission()} />)
    expect(screen.queryByText(/view details/)).toBeNull()
    expect(container.firstElementChild!.className).not.toContain('cursor-pointer')
    rerender(<MissionCard mission={mission()} onClick={() => {}} />)
    expect(screen.getByText(/view details/)).toBeInTheDocument()
    expect(container.firstElementChild!.className).toContain('cursor-pointer')
  })

  it('does not show a duration ending at expiresAt when completedAt is missing', () => {
    render(<MissionCard mission={mission({ startedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T05:00:00Z' })} />)
    expect(screen.getByText('Finished (time unknown)')).toBeInTheDocument()
    expect(screen.queryByText(/Duration/)).toBeNull()
  })

  it('treats CleaningUp as finished only with completedAt', () => {
    const { unmount } = render(<MissionCard mission={mission({ phase: 'CleaningUp', startedAt: '2026-01-01T00:00:00Z' })} />)
    expect(screen.queryByRole('button', { name: /results/ })).toBeNull()
    unmount()
    render(<MissionCard mission={mission({ phase: 'CleaningUp', completedAt: '2026-01-01T00:01:00Z' })} />)
    expect(screen.getByRole('button', { name: /results/ })).toBeInTheDocument()
  })

  it('sets aria-expanded on toggles', async () => {
    render(<MissionCard mission={mission({ successCriteria: 'ok' })} />)
    const b = screen.getByRole('button', { name: /Success Criteria/ })
    expect(b).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(b)
    expect(b).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('MissionCard results', () => {
  it('encodes the name; 404 is "No results", others are errors', async () => {
    const get = vi.mocked(apiGet)
    get.mockRejectedValueOnce(new ApiError(404, 'not found'))
    render(<MissionCard mission={mission({ name: 'a/b' })} />)
    await userEvent.click(screen.getByRole('button', { name: 'results' }))
    expect(await screen.findByText('No results stored yet')).toBeInTheDocument()
    expect(get.mock.calls.at(-1)![0]).toBe('/api/missions/a%2Fb/results')
    await userEvent.click(screen.getByRole('button', { name: 'hide results' }))
    get.mockRejectedValueOnce(new ApiError(500, 'kaput'))
    await userEvent.click(screen.getByRole('button', { name: 'results' }))
    expect(await screen.findByText('Could not load results: kaput')).toBeInTheDocument()
  })
})

describe('MissionCard delete', () => {
  it.each(['Succeeded', 'Failed', 'Expired'])('offers Delete for %s and deletes without opening the card', async (phase) => {
    const onClick = vi.fn(); const onDeleted = vi.fn()
    render(<MissionCard mission={mission({ phase })} onClick={onClick} onDeleted={onDeleted} />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete mission costly' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await vi.waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1))
    expect(apiDelete).toHaveBeenLastCalledWith('/api/missions/costly')
    expect(onClick).not.toHaveBeenCalled()
  })

  it.each(['Active', 'Planning', 'Pending'])('has no Delete button for %s', (phase) => {
    render(<MissionCard mission={mission({ phase })} />)
    expect(screen.queryByRole('button', { name: /Delete mission/ })).not.toBeInTheDocument()
  })
})
