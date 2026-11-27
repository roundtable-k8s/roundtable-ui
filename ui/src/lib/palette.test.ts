import { describe, it, expect } from 'vitest'
import { buildEntries, rank } from './palette'

const entries = buildEntries({
  pages: [{ path: '/fleet', label: 'Fleet' }, { path: '/chains', label: 'Chains' }],
  knights: [{ name: 'galahad', namespace: 'rt', domain: 'security' }, { name: 'bors', namespace: 'rt', domain: 'galaxy' }],
  chains: [{ name: 'nightly-galahad', namespace: 'rt', phase: 'Running' }],
  schedules: [{ name: 'gal-sched', namespace: 'rt' }],
  missions: [{ name: 'm1', namespace: 'rt' }],
  triggers: [{ name: 'hook', namespace: 'rt' }],
})

describe('palette', () => {
  it('builds deep links', () => {
    const to = (k: string) => entries.find(e => e.kind === k)!.to
    expect(to('knight')).toBe('/fleet?knight=galahad')
    expect(to('chain')).toBe('/chains?chain=nightly-galahad')
    expect(to('schedule')).toBe('/schedules/rt/gal-sched')
    expect(to('mission')).toBe('/missions/m1')
    expect(to('trigger')).toBe('/triggers/rt/hook')
  })
  it('shows pages for an empty query', () => {
    expect(rank(entries, '  ').map(e => e.label)).toEqual(['Fleet', 'Chains'])
  })
  it('ranks word-start and name matches before substring and sub-text, stably', () => {
    expect(rank(entries, 'gal').map(e => e.label)).toEqual(['galahad', 'nightly-galahad', 'gal-sched', 'bors'])
  })
  it('is case-insensitive and returns nothing without a match', () => {
    expect(rank(entries, 'GALAHAD')[0].label).toBe('galahad')
    expect(rank(entries, 'zzz')).toEqual([])
  })
  it('caps at 20', () => {
    const many = buildEntries({ missions: Array.from({ length: 50 }, (_, i) => ({ name: `m${i}` })) })
    expect(rank(many, 'm')).toHaveLength(20)
  })
})
