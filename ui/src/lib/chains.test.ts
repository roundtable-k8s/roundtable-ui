import { describe, it, expect } from 'vitest'
import {
  applyChainUpdate, elapsedLabel, fanOutCounts, heartbeatLabel, loopLabel, loopRounds, roundFailed,
  parseChainUpdate, runningHref, scheduleSummary, skipReasonText, sortedItems, sortScheduledFirst,
} from './chains'
import { fanOutChain, prPipelineChain } from '../test/fixtures/chains'
import type { Chain } from './types'

describe('fanOutCounts', () => {
  it('uses the operator counters, which include omitted items', () => {
    const f = fanOutChain().steps![1].fanOut!
    expect(fanOutCounts(f)).toEqual({ total: 12, done: 6, running: 2, failed: 1, skipped: 0, pending: 3, omitted: 5 })
  })

  it('falls back to counting listed items when counters are absent', () => {
    const c = fanOutCounts({ total: 4, items: [
      { index: 0, phase: 'Succeeded' }, { index: 1, phase: 'Running' }, { index: 2, phase: 'Failed' },
    ] })
    expect(c).toEqual({ total: 4, done: 1, running: 1, failed: 1, skipped: 0, pending: 1, omitted: 0 })
  })
})

it('sortedItems puts running first, then failed, then finished', () => {
  expect(sortedItems(fanOutChain().steps![1].fanOut!).map(i => i.index)).toEqual([7, 8, 3, 6])
})

describe('skipReasonText', () => {
  it('explains when-skips with the expression', () => {
    expect(skipReasonText({ skipReason: 'WhenFalse', when: 'x == 1' })).toBe('when condition was false: x == 1')
  })
  it('prefers the API skipMessage when present', () => {
    expect(skipReasonText({ skipReason: 'WhenFalse', when: 'x == 1', skipMessage: 'api says so' })).toBe('api says so')
    expect(skipReasonText({ skipReason: 'WhenFalse', when: 'x == 1', skipMessage: '' })).toBe('when condition was false: x == 1')
  })
  it('does not repeat "skipped" for the real API chain-failed message', () => {
    const text = skipReasonText({ skipReason: 'ChainFailed', skipMessage: 'the chain failed before this step ran' })
    expect(`Skipped: ${text}`).toBe('Skipped: the chain failed before this step ran')
  })
  it('explains chain-failed skips and passes unknown reasons through', () => {
    expect(skipReasonText({ skipReason: 'ChainFailed' })).toBe('the chain failed before this step ran')
    expect(skipReasonText({ skipReason: 'Cancelled' })).toBe('Cancelled')
    expect(skipReasonText({})).toBe('no reason reported')
  })
})

it('loop rounds and label', () => {
  const loop = prPipelineChain().steps![1].loop!
  expect(loopLabel(loop)).toBe('round 2/5')
  expect(loopRounds(loop).map(r => r.iteration)).toEqual([2, 1])
})

it('roundFailed flags a failed or errored body step', () => {
  expect(roundFailed({ iteration: 1, steps: [{ name: 'a', phase: 'Succeeded' }] })).toBe(false)
  expect(roundFailed({ iteration: 1, steps: [{ name: 'a', phase: 'Succeeded' }, { name: 'b', phase: 'Failed' }] })).toBe(true)
  expect(roundFailed({ iteration: 1, steps: [{ name: 'a', phase: 'Succeeded', error: 'x' }] })).toBe(true)
})

it('elapsed and heartbeat labels', () => {
  const now = Date.parse('2026-11-24T10:01:05Z')
  expect(elapsedLabel({ startTime: '2026-11-24T10:00:00Z' }, now)).toBe('1m 5s')
  expect(elapsedLabel({ inFlight: { elapsedMs: 30000 } })).toBe('30s')
  expect(elapsedLabel({})).toBe('—')
  expect(heartbeatLabel({ inFlight: { elapsedMs: 0, heartbeatAgeMs: 4000 } })).toBe('4s ago')
  expect(runningHref('a b')).toBe('/running?task=a%20b')
})

describe('chain WS updates', () => {
  const chains: Chain[] = [fanOutChain(), prPipelineChain()]

  it('upserts in place and appends new chains', () => {
    const changed = { ...prPipelineChain(), phase: 'Succeeded' }
    const u = parseChainUpdate(changed, { type: 'chain', op: 'upsert' })!
    const next = applyChainUpdate(chains, u)
    expect(next.map(c => [c.name, c.phase])).toEqual([['doc-sweep', 'Running'], ['pr-pipeline', 'Succeeded']])

    const added = applyChainUpdate(chains, parseChainUpdate({ ...fanOutChain(), name: 'new' })!)
    expect(added.map(c => c.name)).toEqual(['doc-sweep', 'pr-pipeline', 'new'])
  })

  it('deletes on op=delete and ignores malformed messages', () => {
    const u = parseChainUpdate({ name: 'doc-sweep', namespace: 'roundtable' }, { op: 'delete' })!
    expect(applyChainUpdate(chains, u).map(c => c.name)).toEqual(['pr-pipeline'])
    expect(parseChainUpdate(null)).toBeNull()
    expect(parseChainUpdate({ phase: 'x' })).toBeNull()
  })
})

describe('scheduled chains', () => {
  const mk = (name: string, extra: Partial<Chain> = {}) => ({ name, namespace: 'n', phase: '', ...extra } as Chain)
  it('sorts scheduled chains first, soonest next run first', () => {
    const out = sortScheduledFirst([
      mk('plain'),
      mk('late', { schedule: '0 1 * * *', nextScheduledAt: '2026-11-27T01:00:00Z' }),
      mk('soon', { schedule: '0 1 * * *', nextScheduledAt: '2026-11-26T01:00:00Z' }),
    ])
    expect(out.map(c => c.name)).toEqual(['soon', 'late', 'plain'])
  })
  it('summarises next and last runs', () => {
    const c = mk('a', { schedule: '0 11 * * *', timeZone: 'UTC', nextScheduledAt: '2026-11-26T11:00:00Z', lastScheduledAt: '2026-11-25T11:00:00Z' })
    const s = scheduleSummary(c, () => 'in 14h', () => '3h ago')
    expect(s).toContain('next in 14h (')
    expect(s).toContain('UTC)')
    expect(s).toContain('last ran 3h ago')
    expect(scheduleSummary({ ...c, suspend: true }, () => 'x', () => 'y')).toMatch(/^suspended/)
    expect(scheduleSummary(mk('p'), () => 'x', () => 'y')).toBe('')
  })
})
