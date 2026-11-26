import { describe, it, expect } from 'vitest'
import { chainLink } from './triggers'

describe('chainLink', () => {
  it('links to the chains page with the chain query', () => {
    expect(chainLink('nightly')).toBe('/chains?chain=nightly')
  })
  it('encodes special characters', () => {
    expect(chainLink('a b&c=d')).toBe('/chains?chain=a+b%26c%3Dd')
  })
})
