import { describe, it, expect } from 'vitest'
import { deadLetterUrl, deadLetterTime, isChainOwned, errorExcerpt, type DeadLetter } from './deadLetters'

function dl(over: Partial<DeadLetter> = {}): DeadLetter {
  return { taskId: 't1', knight: 'galahad', state: 'open', reason: 'failed', attempt: 1, updatedAt: '2026-11-24T10:00:00Z', ...over }
}

describe('deadLetterUrl', () => {
  it('has no query without a table', () => {
    expect(deadLetterUrl({ taskId: 't1' })).toBe('/api/dead-letters/t1')
  })
  it('adds the table query', () => {
    expect(deadLetterUrl({ taskId: 't1', table: 'fleet-a' })).toBe('/api/dead-letters/t1?table=fleet-a')
  })
  it('encodes the id and the table', () => {
    expect(deadLetterUrl({ taskId: 'a/b c?', table: 'x&y' })).toBe('/api/dead-letters/a%2Fb%20c%3F?table=x%26y')
  })
})

describe('deadLetterTime', () => {
  it('prefers deadLetteredAt', () => {
    expect(deadLetterTime(dl({ deadLetteredAt: '2026-11-24T09:00:00Z' }))).toBe('2026-11-24T09:00:00Z')
  })
  it('falls back to updatedAt', () => {
    expect(deadLetterTime(dl())).toBe('2026-11-24T10:00:00Z')
  })
})

describe('isChainOwned', () => {
  it('is true with a chain name only', () => {
    expect(isChainOwned(dl({ chainName: 'nightly' }))).toBe(true)
    expect(isChainOwned(dl())).toBe(false)
    expect(isChainOwned(dl({ chainName: '' }))).toBe(false)
  })
})

describe('errorExcerpt', () => {
  it('returns the first line, trimmed', () => {
    expect(errorExcerpt('  first\nsecond\nthird ')).toBe('first')
  })
  it('is empty for undefined or blank', () => {
    expect(errorExcerpt(undefined)).toBe('')
    expect(errorExcerpt('   ')).toBe('')
  })
  it('keeps a line of exactly max chars', () => {
    expect(errorExcerpt('abcde', 5)).toBe('abcde')
  })
  it('cuts longer lines to max with an ellipsis', () => {
    expect(errorExcerpt('abcdefgh', 5)).toBe('abcd…')
    expect(errorExcerpt('x'.repeat(100))).toHaveLength(80)
  })
})
