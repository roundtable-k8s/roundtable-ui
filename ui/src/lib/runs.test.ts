import { describe, it, expect } from 'vitest'
import { runRows, ageLabel, issueUrl, runsUrl } from './runs'

describe('runRows', () => {
  it('reads {runs}', () => expect(runRows({ runs: [{ run: 'a' }, { x: 1 }, null] })).toEqual([{ run: 'a' }]))
  it('tolerates junk', () => {
    expect(runRows(null)).toEqual([])
    expect(runRows({})).toEqual([])
    expect(runRows({ runs: 'x' })).toEqual([])
  })
})

describe('ageLabel', () => {
  it('formats', () => {
    expect(ageLabel(5)).toBe('5s')
    expect(ageLabel(125)).toBe('2m')
    expect(ageLabel(3700)).toBe('1h 1m')
    expect(ageLabel(90000)).toBe('1d 1h')
    expect(ageLabel(-3)).toBe('0s')
    expect(ageLabel(undefined)).toBe('—')
    expect(ageLabel(NaN)).toBe('—')
  })
})

describe('issueUrl', () => {
  it('builds a github url', () => expect(issueUrl({ repo: 'acme/app', number: 12 })).toBe('https://github.com/acme/app/issues/12'))
  it('rejects bad input', () => {
    expect(issueUrl(undefined)).toBe('')
    expect(issueUrl({ repo: 'evil.com/x/y', number: 1 })).toBe('')
    expect(issueUrl({ repo: 'a/../b', number: 1 })).toBe('')
    expect(issueUrl({ repo: '../x', number: 1 })).toBe('')
    expect(issueUrl({ repo: 'a/b?x', number: 1 })).toBe('')
    expect(issueUrl({ repo: 'a/b', number: 0 })).toBe('')
    expect(issueUrl({ repo: 'a/b', number: 1.5 })).toBe('')
  })
})

describe('runsUrl', () => {
  it('builds query', () => {
    expect(runsUrl('all', false)).toBe('/api/gateway/runs?source=all&limit=100')
    expect(runsUrl('pickup', true)).toBe('/api/gateway/runs?source=pickup&limit=100&active=true')
  })
})
