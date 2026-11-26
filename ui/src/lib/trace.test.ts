import { describe, it, expect } from 'vitest'
import { traceUrl } from './trace'

const id = '0af7651916cd43dd8448eb211c80319c'

describe('traceUrl', () => {
  it('fills the placeholder', () => {
    expect(traceUrl('https://t.example/trace/{traceId}', id)).toBe(`https://t.example/trace/${id}`)
  })
  it('returns null when a value is missing or unusable', () => {
    expect(traceUrl(undefined, id)).toBeNull()
    expect(traceUrl('https://t.example/{traceId}', undefined)).toBeNull()
    expect(traceUrl('https://t.example/{traceId}', 'short')).toBeNull()
    expect(traceUrl('javascript:alert({traceId})', id)).toBeNull()
    expect(traceUrl('https://t.example/trace', id)).toBeNull()
  })
})
