import { describe, it, expect } from 'vitest'
import { parseQuantity, usageFraction, podState, formatCpu, formatMemory } from './pods'
import type { KnightPod } from '../hooks/useFleet'

const pod = (o: Partial<KnightPod>): KnightPod => ({ name: 'p', phase: 'Running', ready: true, restarts: 0, age: '1m', draining: false, ...o })

describe('pods helpers', () => {
  it('parses quantities', () => {
    expect(parseQuantity('150m')).toBeCloseTo(0.15)
    expect(parseQuantity('256Mi')).toBe(256 * 1024 * 1024)
    expect(parseQuantity('2')).toBe(2)
    expect(parseQuantity('bogus')).toBeNull()
    expect(parseQuantity(undefined)).toBeNull()
  })
  it('computes usage fraction with request fallback', () => {
    expect(usageFraction('500m', '1')).toBeCloseTo(0.5)
    expect(usageFraction('100Mi', undefined, '200Mi')).toBeCloseTo(0.5)
    expect(usageFraction(undefined, '1')).toBeNull()
    expect(usageFraction('1', undefined, undefined)).toBeNull()
  })
  it('classifies pod state, draining first', () => {
    expect(podState(pod({ draining: true }))).toBe('draining')
    expect(podState(pod({}))).toBe('ready')
    expect(podState(pod({ ready: false }))).toBe('starting')
  })
  it('formats', () => {
    expect(formatCpu('150m')).toBe('150m')
    expect(formatMemory('268435456')).toBe('256Mi')
    expect(formatCpu(undefined)).toBe('—')
  })
})
