import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { IsolationBadge } from './IsolationBadge'
import type { KnightIsolation } from '../hooks/useFleet'

const iso = (over: Partial<KnightIsolation>): KnightIsolation => ({ state: 'isolated', ...over }) as KnightIsolation

describe('IsolationBadge', () => {
  it.each([
    ['isolated', 'isolated'],
    ['opted-out', 'opted out'],
    ['not-enforced', 'not enforced'],
    ['unknown', 'isolation unknown'],
  ] as const)('labels state %s', (state, label) => {
    render(<IsolationBadge isolation={iso({ state })} />)
    const badge = screen.getByTestId('isolation-badge')
    expect(badge).toHaveTextContent(label)
    expect(badge).toHaveAttribute('data-state', state)
  })

  it('shows the opt-out reason on hover', () => {
    render(<IsolationBadge isolation={iso({ state: 'opted-out', runtimeOptOut: true, optOutReason: 'needs docker' })} />)
    expect(screen.getByTestId('isolation-badge')).toHaveAttribute('title', 'Opted out (runtime: none): needs docker')
  })

  it('explains the unknown state', () => {
    render(<IsolationBadge isolation={iso({ state: 'unknown' })} />)
    expect(screen.getByTestId('isolation-badge').getAttribute('title')).toMatch(/has not reported/)
  })

  it('falls back to unknown styling for an unexpected state', () => {
    render(<IsolationBadge isolation={iso({ state: 'weird' as never })} />)
    const badge = screen.getByTestId('isolation-badge')
    expect(badge).toHaveTextContent('weird')
    expect(badge.className).toContain('text-gray-400')
  })
})
