import { describe, it, expect } from 'vitest'
import { isFinalStatus, knightKey, mergeTurn, type ChatTurn } from './chat'

describe('isFinalStatus', () => {
  it('is true only for succeeded and failed', () => {
    expect(isFinalStatus('succeeded')).toBe(true)
    expect(isFinalStatus('failed')).toBe(true)
    expect(isFinalStatus('running')).toBe(false)
    expect(isFinalStatus('')).toBe(false)
    expect(isFinalStatus(undefined)).toBe(false)
  })
})

describe('knightKey', () => {
  it('prefixes the namespace when there is one', () => {
    expect(knightKey({ name: 'galahad', namespace: 'fleet' })).toBe('fleet/galahad')
  })
  it('is the bare name without a namespace', () => {
    expect(knightKey({ name: 'galahad' })).toBe('galahad')
    expect(knightKey({ name: 'galahad', namespace: '' })).toBe('galahad')
  })
})

describe('mergeTurn', () => {
  const turn: ChatTurn = { id: 1, message: 'hi', taskId: 't1', status: 'running', costUsd: 0.5, toolCalls: 3, output: 'old' }

  it('keeps the old cost and tool calls unless numbers arrive', () => {
    const m = mergeTurn(turn, { taskId: 't1', status: 'succeeded' })
    expect(m.costUsd).toBe(0.5)
    expect(m.toolCalls).toBe(3)
    expect(m.status).toBe('succeeded')
    expect(m.output).toBe('old')
  })
  it('takes new numbers, including zero', () => {
    const m = mergeTurn(turn, { taskId: 't1', costUsd: 0, toolCalls: 7 })
    expect(m.costUsd).toBe(0)
    expect(m.toolCalls).toBe(7)
    expect(m.status).toBe('running')
  })
  it('ignores non-number cost values', () => {
    const m = mergeTurn(turn, { taskId: 't1', costUsd: '1.2' as unknown as number })
    expect(m.costUsd).toBe(0.5)
  })
  it('keeps the old task id when the new one is empty and overrides other fields', () => {
    const m = mergeTurn(turn, { taskId: '', output: 'new', error: 'boom', model: 'm' })
    expect(m).toMatchObject({ taskId: 't1', output: 'new', error: 'boom', model: 'm', id: 1, message: 'hi' })
  })
})
