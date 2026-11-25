import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MissionCard } from './MissionCard'
import type { Mission } from '../hooks/useMissions'

vi.mock('../lib/api', () => ({ apiGet: vi.fn(() => Promise.reject(new Error('none'))) }))

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
