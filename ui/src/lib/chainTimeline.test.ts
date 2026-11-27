import { describe, it, expect } from 'vitest'
import { timelineRows } from './chainTimeline'
import type { Chain, ChainStep } from './types'

const T0 = Date.parse('2026-01-01T00:00:00Z')
const iso = (sec: number) => new Date(T0 + sec * 1000).toISOString()

function step(name: string, o: Partial<ChainStep> = {}): ChainStep {
  return { name, knight: 'k', domain: 'd', phase: 'Succeeded', startTime: null, completionTime: null,
    result: null, dependsOn: null, retryCount: 0, ...o }
}
function chain(steps: ChainStep[], o: Partial<Chain> = {}): Chain {
  return { name: 'c', namespace: 'ns', phase: 'Succeeded', currentStep: '', startTime: iso(0),
    completionTime: iso(100), steps, ...o } as Chain
}

describe('timelineRows', () => {
  it('lays sequential steps against the run span', () => {
    const rows = timelineRows(chain([
      step('a', { startTime: iso(0), completionTime: iso(20), costUSD: '0.5' }),
      step('b', { startTime: iso(20), completionTime: iso(50) }),
      step('c', { startTime: iso(50), completionTime: iso(100) }),
    ]), T0 + 200_000)
    expect(rows.map(r => [r.startPct, r.widthPct])).toEqual([[0, 20], [20, 30], [50, 50]])
    expect(rows[0].durationMs).toBe(20_000)
    expect(rows[0].costUSD).toBe('0.5')
  })
  it('overlaps parallel steps', () => {
    const rows = timelineRows(chain([
      step('a', { startTime: iso(0), completionTime: iso(60) }),
      step('b', { startTime: iso(10), completionTime: iso(40) }),
    ]), T0 + 200_000)
    expect(rows[1].startPct).toBe(10)
    expect(rows[1].widthPct).toBe(30)
  })
  it('ends a running step and run at now', () => {
    const rows = timelineRows(chain([
      step('a', { startTime: iso(0), completionTime: iso(10) }),
      step('b', { phase: 'Running', startTime: iso(10) }),
    ], { phase: 'Running', completionTime: null }), T0 + 40_000)
    expect(rows[0].widthPct).toBe(25)
    expect(rows[1].startPct).toBe(25)
    expect(rows[1].widthPct).toBe(75)
    expect(rows[1].durationMs).toBe(30_000)
  })
  it('gives skipped and pending steps no bar', () => {
    const rows = timelineRows(chain([
      step('a', { startTime: iso(0), completionTime: iso(10) }),
      step('s', { phase: 'Skipped' }),
    ]), T0 + 200_000)
    expect(rows[1].startPct).toBeUndefined()
    expect(rows[1].durationMs).toBeUndefined()
    expect(rows[1].name).toBe('s')
  })
  it('turns loop rounds into segments', () => {
    const body = (n: number, a: number, b: number) => ({ name: 'x', phase: 'Succeeded', startTime: iso(a), completionTime: iso(b), iteration: n })
    const rows = timelineRows(chain([
      step('loop', {
        startTime: iso(0), completionTime: iso(100),
        loop: { iteration: 2, maxIterations: 3, rounds: [
          { iteration: 1, steps: [body(1, 0, 40)] },
          { iteration: 2, steps: [body(2, 40, 100)] },
        ] },
      }),
    ]), T0 + 200_000)
    expect(rows[0].rounds).toEqual([
      { iteration: 1, startPct: 0, widthPct: 40, durationMs: 40_000 },
      { iteration: 2, startPct: 40, widthPct: 60, durationMs: 60_000 },
    ])
  })
  it('handles a zero-length run', () => {
    const rows = timelineRows(chain([
      step('a', { startTime: iso(0), completionTime: iso(0) }),
    ], { completionTime: iso(0) }), T0 + 5000)
    expect(rows[0].startPct).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(rows[0].widthPct)).toBe(true)
  })
})
