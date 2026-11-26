import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { RunCostTable } from './RunCostTable'
import type { Chain, ChainStep } from '../lib/types'

function step(over: Partial<ChainStep>): ChainStep {
  return { name: 's', knight: 'galahad', domain: 'security', phase: 'Succeeded', startTime: null, completionTime: null, result: null, dependsOn: null, retryCount: 0, ...over }
}
function chain(over: Partial<Chain> = {}): Chain {
  return { name: 'nightly', namespace: 'fleet', phase: 'Succeeded', currentStep: '', startTime: null, completionTime: null, steps: [], ...over }
}

describe('RunCostTable', () => {
  it('renders a row per step and the total', () => {
    render(<RunCostTable chain={chain({
      costUSD: '1.5', tokens: { input: 12000, output: 1500 },
      steps: [
        step({ name: 'scan', knight: 'galahad', costUSD: '1.5', tokens: { input: 12000, output: 1500 } }),
        step({ name: 'report', knight: 'kay', costUSD: '0.25', costNotional: true }),
      ],
    })} />)
    const table = screen.getByRole('table', { name: 'nightly cost' })
    expect(within(table).getByText('scan')).toBeInTheDocument()
    expect(within(table).getByText('kay')).toBeInTheDocument()
    expect(within(table).getByText('$0.25')).toBeInTheDocument()
    expect(within(table).getByText('notional')).toBeInTheDocument()
    expect(within(table).getAllByText('12k in / 1.5k out')).toHaveLength(2)
    expect(within(table).getByText('Total')).toBeInTheDocument()
  })

  it('shows dashes for steps and total without cost data', () => {
    render(<RunCostTable chain={chain({ steps: [step({ name: 'scan' })] })} />)
    // step cost, step tokens, total cost, total tokens
    expect(screen.getAllByText('—')).toHaveLength(4)
  })

  it('handles a null step list', () => {
    render(<RunCostTable chain={chain({ steps: null })} />)
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getAllByRole('row')).toHaveLength(2) // header + total
  })
})
