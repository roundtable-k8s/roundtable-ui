import { describe, it, expect } from 'vitest'
import { SubmissionKey } from './submissionKey'

describe('SubmissionKey', () => {
  it('keeps the key after a network error or 5xx, same payload', () => {
    const k = new SubmissionKey()
    const a = k.next('p')
    k.settle(new TypeError('Failed to fetch'))
    expect(k.next('p')).toBe(a)
    k.settle(Object.assign(new Error('x'), { status: 500 }))
    expect(k.next('p')).toBe(a)
  })
  it('renews after success, a 4xx or a changed payload', () => {
    const k = new SubmissionKey()
    const a = k.next('p')
    k.settle()
    const b = k.next('p')
    expect(b).not.toBe(a)
    k.settle(Object.assign(new Error('x'), { status: 400 }))
    const c = k.next('p')
    expect(c).not.toBe(b)
    expect(k.next('q')).not.toBe(c)
  })
})
