import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PlanningResultViewer } from './PlanningResultViewer'
import type { PlanningResult } from '../hooks/useMissions'

const base: PlanningResult = { completedAt: '2026-11-24T10:00:00Z', chainsGenerated: 2, knightsGenerated: 3, skillsGenerated: 4 }

describe('PlanningResultViewer', () => {
  it('shows the counts and reasoning on success', () => {
    render(<PlanningResultViewer result={{ ...base, reasoning: 'split in two' }} />)
    expect(screen.getByText('Planning Complete')).toBeInTheDocument()
    expect(screen.getByText('Chains').nextSibling).toHaveTextContent('2')
    expect(screen.getByText('Knights').nextSibling).toHaveTextContent('3')
    expect(screen.getByText('Skills').nextSibling).toHaveTextContent('4')
    expect(screen.getByText('split in two')).toBeInTheDocument()
    expect(screen.queryByText(/Generated Plan/)).toBeNull()
  })

  it('shows the error and hides the counts on failure', () => {
    render(<PlanningResultViewer result={{ ...base, error: 'bad plan' }} />)
    expect(screen.getByText('Planning Failed')).toBeInTheDocument()
    expect(screen.getByText('Planning Error: bad plan')).toBeInTheDocument()
    expect(screen.queryByText('Chains')).toBeNull()
  })

  it('toggles a pretty-printed plan', () => {
    render(<PlanningResultViewer result={{ ...base, rawOutput: '{"a":1}' }} />)
    fireEvent.click(screen.getByRole('button', { name: /View Generated Plan/ }))
    expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === '{\n  "a": 1\n}')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Hide Generated Plan/ }))
    expect(screen.queryByText(/"a"/)).toBeNull()
  })

  it('shows non-JSON output verbatim', () => {
    render(<PlanningResultViewer result={{ ...base, rawOutput: 'not json' }} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('not json')).toBeInTheDocument()
  })
})
