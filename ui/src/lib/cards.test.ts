import { describe, it, expect } from 'vitest'
import {
  applyCardPush,
  cardForKnight,
  cardKey,
  cardLoad,
  cardSkillTags,
  matchesSkillFilter,
  parseCardPush,
  parseCardsResponse,
} from './cards'
import { galahadCard, patsyCard } from '../test/fixtures/cards'

const raw = {
  schemaVersion: 1,
  name: 'galahad',
  description: 'Security analyst',
  version: 7,
  skills: [{ id: 'cve-triage', description: 'Triage', tags: ['security', 3] }, { nope: true }],
  roundtable: { table: 'personal', knight: 'galahad', model: 'm', tools: ['nmap'], suspended: false },
}

describe('parseCardsResponse', () => {
  it('parses entries and skips unusable ones', () => {
    const m = parseCardsResponse({
      cards: [
        { table: 'personal', knight: 'galahad', card: raw, live: true, stats: { activeTasks: 0 } },
        { table: 'personal', knight: 'kay', card: JSON.stringify({ ...raw, name: 'kay' }), live: false, stats: null },
        { table: 'personal', knight: 'bad', card: 'not json' },
        'garbage',
      ],
    })
    expect([...m.keys()]).toEqual(['personal.galahad', 'personal.kay'])
    const g = m.get('personal.galahad')!
    expect(g.live).toBe(true)
    expect(g.card.version).toBe('7')
    expect(g.card.skills).toEqual([{ id: 'cve-triage', name: 'cve-triage', description: 'Triage', tags: ['security'] }])
    expect(g.card.roundtable.tools).toEqual(['nmap'])
    expect(m.get('personal.kay')!.live).toBe(false)
  })

  it('tolerates missing or odd bodies', () => {
    expect(parseCardsResponse(null).size).toBe(0)
    expect(parseCardsResponse({}).size).toBe(0)
    expect(parseCardsResponse({ cards: 'x' }).size).toBe(0)
  })
})

describe('card pushes', () => {
  it('upserts and deletes', () => {
    let m = parseCardsResponse({ cards: [] })
    const up = parseCardPush({ table: 'personal', knight: 'galahad', card: raw, live: true, stats: null })!
    m = applyCardPush(m, up)
    expect(m.get(cardKey('personal', 'galahad'))!.card.description).toBe('Security analyst')
    const del = parseCardPush({ table: 'personal', knight: 'galahad', deleted: true })!
    expect(del).toEqual({ op: 'delete', table: 'personal', knight: 'galahad' })
    m = applyCardPush(m, del)
    expect(m.size).toBe(0)
  })

  it('ignores malformed pushes', () => {
    expect(parseCardPush(null)).toBeNull()
    expect(parseCardPush({ deleted: true })).toBeNull()
    expect(parseCardPush({ table: 't', knight: 'k' })).toBeNull()
  })
})

describe('cardForKnight', () => {
  const m = new Map([
    ['a.galahad', { ...galahadCard, table: 'a' }],
    ['b.galahad', { ...galahadCard, table: 'b' }],
  ])
  it('matches case-insensitively and prefers the given table', () => {
    expect(cardForKnight(m, 'Galahad')!.table).toBe('a')
    expect(cardForKnight(m, 'galahad', 'b')!.table).toBe('b')
    expect(cardForKnight(m, 'galahad', 'zzz')!.table).toBe('a')
    expect(cardForKnight(m, 'kay')).toBeUndefined()
  })
})

describe('cardLoad', () => {
  it('reads counters from micro STATS endpoint data', () => {
    expect(cardLoad(galahadCard)).toEqual({ active: 1, max: 3 })
  })
  it('reads flat stats and falls back for max', () => {
    expect(cardLoad({ ...galahadCard, stats: { activeTasks: 2 } }, 5)).toEqual({ active: 2, max: 5 })
  })
  it('sums per-pod stats arrays', () => {
    const stats = [{ activeTasks: 1, maxConcurrentTasks: 2 }, { endpoints: [{ data: { activeTasks: 2, maxConcurrentTasks: 2 } }] }]
    expect(cardLoad({ ...galahadCard, stats })).toEqual({ active: 3, max: 4 })
  })
  it('is null without stats or card', () => {
    expect(cardLoad(patsyCard)).toBeNull()
    expect(cardLoad(undefined)).toBeNull()
  })
})

describe('skill filter', () => {
  it('collects sorted unique tags', () => {
    expect(cardSkillTags([galahadCard, patsyCard])).toEqual(['design', 'security', 'vault'])
  })

  it('matches everything when inactive', () => {
    expect(matchesSkillFilter(undefined, {})).toBe(true)
    expect(matchesSkillFilter(undefined, { text: '  ' })).toBe(true)
  })

  it('matches by tag, case-insensitively', () => {
    expect(matchesSkillFilter(galahadCard, { tag: 'Security' })).toBe(true)
    expect(matchesSkillFilter(patsyCard, { tag: 'security' })).toBe(false)
  })

  it('matches free text on name, description and tags', () => {
    expect(matchesSkillFilter(galahadCard, { text: 'cve' })).toBe(true)
    expect(matchesSkillFilter(galahadCard, { text: 'design doc' })).toBe(true)
    expect(matchesSkillFilter(galahadCard, { text: 'design' })).toBe(true)
    expect(matchesSkillFilter(galahadCard, { text: 'kubernetes' })).toBe(false)
  })

  it('requires tag and text on the same skill', () => {
    expect(matchesSkillFilter(galahadCard, { tag: 'design', text: 'threat' })).toBe(true)
    expect(matchesSkillFilter(galahadCard, { tag: 'design', text: 'cve' })).toBe(false)
  })

  it('never matches a knight without a card when active', () => {
    expect(matchesSkillFilter(undefined, { text: 'cve' })).toBe(false)
  })
})
