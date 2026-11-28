import { describe, it, expect } from 'vitest'
import { KNIGHT_CONFIG, buildKnightConfigFromFleet, getKnightConfig, knightNameForDomain, domainIndex } from './knights'

describe('buildKnightConfigFromFleet', () => {
  it('keeps the built-in config and does not mutate it', () => {
    const cfg = buildKnightConfigFromFleet([{ name: 'galahad', domain: 'whatever' }])
    expect(cfg.galahad).toBe(KNIGHT_CONFIG.galahad)
    buildKnightConfigFromFleet([{ name: 'newbie', domain: 'qa' }])
    expect(KNIGHT_CONFIG.newbie).toBeUndefined()
  })
  it('derives emoji, colour and title from the domain of an unknown knight', () => {
    const cfg = buildKnightConfigFromFleet([{ name: 'tester', domain: 'qa' }])
    expect(cfg.tester).toEqual({ emoji: '🧪', color: 'text-lime-400', title: 'Qa', domain: 'qa' })
  })
  it('falls back to a robot and grey for an unknown domain', () => {
    const cfg = buildKnightConfigFromFleet([{ name: 'odd', domain: 'mystery' }])
    expect(cfg.odd).toEqual({ emoji: '🤖', color: 'text-gray-400', title: 'Mystery', domain: 'mystery' })
  })
})

describe('getKnightConfig', () => {
  it('returns the known config', () => {
    expect(getKnightConfig('kay').title).toBe('Research')
  })
  it('returns a default named after the knight when unknown', () => {
    expect(getKnightConfig('nobody')).toEqual({ emoji: '🤖', color: 'text-gray-400', title: 'nobody', domain: 'nobody' })
  })
})

describe('knightNameForDomain', () => {
  it('matches a knight name directly', () => {
    expect(knightNameForDomain('galahad')).toBe('galahad')
  })
  it('maps a domain to its first knight', () => {
    expect(knightNameForDomain('security')).toBe('galahad')
    expect(knightNameForDomain('coding')).toBe('coder-1')
  })
  it('returns null when nothing matches', () => {
    expect(knightNameForDomain('nope')).toBeNull()
  })
})

describe('domainIndex', () => {
  it('maps a domain to its only knight', () => {
    const idx = domainIndex([{ name: 'rt-ui', domain: 'ui' }, { name: 'kay', domain: 'research' }])
    expect(idx.get('ui')).toBe('rt-ui')
    expect(idx.get('research')).toBe('kay')
  })
  it('drops a domain shared by several knights and ignores empty domains', () => {
    const idx = domainIndex([{ name: 'a', domain: 'coding' }, { name: 'b', domain: 'coding' }, { name: 'c', domain: '' }])
    expect(idx.has('coding')).toBe(false)
    expect(idx.size).toBe(0)
  })
})
