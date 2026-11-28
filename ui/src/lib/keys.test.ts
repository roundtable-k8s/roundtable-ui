import { describe, expect, it } from 'vitest'
import { namespacedKey } from './keys'

describe('namespacedKey', () => {
  it('joins namespace and name', () => { expect(namespacedKey({ namespace: 'rt', name: 'kay' })).toBe('rt/kay') })
  it('keeps a leading slash without a namespace', () => { expect(namespacedKey({ name: 'kay' })).toBe('/kay') })
})
