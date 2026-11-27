import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { ChainTimeline } from './ChainTimeline'
import type { Chain, ChainStep } from '../lib/types'

const T0 = Date.parse('2026-01-01T00:00:00Z')
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString()
const step = (name: string, o: Partial<ChainStep> = {}): ChainStep => ({
  name, knight: 'k', domain: 'd', phase: 'Succeeded', startTime: null, completionTime: null,
  result: null, dependsOn: null, retryCount: 0, ...o })

const chain = {
  name: 'c', namespace: 'ns', phase: 'Succeeded', currentStep: '', startTime: iso(0), completionTime: iso(100),
  steps: [
    step('a', { startTime: iso(0), completionTime: iso(20), costUSD: '0.5' }),
    step('b', { startTime: iso(20), completionTime: iso(50) }),
    step('c', { startTime: iso(50), completionTime: iso(100) }),
    step('skipped-one', { phase: 'Skipped' }),
    step('loop', { startTime: iso(0), completionTime: iso(10), loop: { iteration: 2, maxIterations: 3, rounds: [
      { iteration: 1, steps: [{ name: 'x', phase: 'Succeeded', startTime: iso(0), completionTime: iso(5) }] },
      { iteration: 2, steps: [{ name: 'x', phase: 'Succeeded', startTime: iso(5), completionTime: iso(10) }] },
    ] } }),
  ],
} as Chain

describe('ChainTimeline', () => {
  it('draws a bar per started step at its offset and width', () => {
    render(<ChainTimeline chain={chain} now={T0 + 200_000} />)
    const b = screen.getByTestId('bar-b')
    expect(b.style.left).toBe('20%')
    expect(b.style.width).toBe('30%')
    expect(b).toHaveAttribute('aria-label', 'b: Succeeded, 30s')
    expect(screen.getByText('$0.50')).toBeInTheDocument()
  })
  it('labels a skipped step without a bar', () => {
    render(<ChainTimeline chain={chain} now={T0 + 200_000} />)
    expect(screen.getByText('skipped-one')).toBeInTheDocument()
    expect(screen.queryByTestId('bar-skipped-one')).toBeNull()
    expect(screen.getByText('Skipped')).toBeInTheDocument()
  })
  it('shows one segment per loop round', () => {
    render(<ChainTimeline chain={chain} now={T0 + 200_000} />)
    expect(screen.getByTestId('round-loop-1')).toBeInTheDocument()
    expect(screen.getByTestId('round-loop-2')).toBeInTheDocument()
  })
  it('selects a step on click', () => {
    const onSelect = vi.fn()
    render(<ChainTimeline chain={chain} now={T0 + 200_000} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'b' }))
    expect(onSelect).toHaveBeenCalledWith('b')
  })
  it('keeps loop rounds inside the step bar', () => {
    const c = { ...chain, steps: [step('loop', { startTime: iso(0), completionTime: iso(10), loop: { iteration: 1, maxIterations: 3, rounds: [
      { iteration: 1, steps: [{ name: 'x', phase: 'Succeeded', startTime: iso(0), completionTime: iso(30) }] },
    ] } })] } as Chain
    render(<ChainTimeline chain={c} now={T0 + 200_000} />)
    const r = screen.getByTestId('round-loop-1')
    expect(parseFloat(r.style.left) + parseFloat(r.style.width)).toBeLessThanOrEqual(100)
    expect(parseFloat(r.style.left)).toBeGreaterThanOrEqual(0)
  })
  it('ticks while the chain runs so the running bar grows', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(T0 + 10_000)
      // Start at 4s, not 0: a running step that starts with the run always fills the span, so its width is pinned at 100.
      const c = { ...chain, phase: 'Running', completionTime: undefined, steps: [step('a', { phase: 'Running', startTime: iso(4) })] } as unknown as Chain
      render(<ChainTimeline chain={c} />)
      const w1 = parseFloat(screen.getByTestId('bar-a').style.width)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(parseFloat(screen.getByTestId('bar-a').style.width)).toBeGreaterThan(w1)
      expect(screen.getByTestId('bar-a')).toHaveAttribute('aria-label', 'a: Running, 7s')
    } finally { vi.useRealTimers() }
  })
  it('does not tick for a finished chain', () => {
    vi.useFakeTimers()
    try {
      render(<ChainTimeline chain={chain} />)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
