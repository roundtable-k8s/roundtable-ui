import { describe, it, expect } from 'vitest'
import {
  applyChainUpdate, elapsedLabel, fanOutCounts, heartbeatLabel, loopLabel, loopRounds,
  parseChainUpdate, runningHref, skipReasonText, sortedItems,
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
