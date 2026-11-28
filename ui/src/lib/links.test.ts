import { describe, expect, it } from 'vitest'
import { chainHref, runningHref } from './links'

describe('links', () => {
  it('chainHref encodes the name', () => {
    expect(chainHref('a b/c')).toBe('/chains?chain=a%20b%2Fc')
  })
  it('runningHref encodes the task id', () => {
    expect(runningHref('a b')).toBe('/running?task=a%20b')
  })
})
