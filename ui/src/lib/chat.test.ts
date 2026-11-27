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
  const turn: ChatTurn = { id: 1, message: 'hi', taskId: 't1', status: 'running', cost: 0.5, toolCalls: 3, output: 'old' }

  it('keeps the old cost and tool calls unless numbers arrive', () => {
    const m = mergeTurn(turn, { taskId: 't1', status: 'succeeded' })
    expect(m.cost).toBe(0.5)
    expect(m.toolCalls).toBe(3)
    expect(m.status).toBe('succeeded')
    expect(m.output).toBe('old')
  })
  it('takes new numbers, including zero', () => {
    const m = mergeTurn(turn, { taskId: 't1', cost: 0, toolCalls: 7 })
    expect(m.cost).toBe(0)
    expect(m.toolCalls).toBe(7)
    expect(m.status).toBe('running')
  })
  it('ignores non-number cost values', () => {
    const m = mergeTurn(turn, { taskId: 't1', cost: '1.2' as unknown as number })
    expect(m.cost).toBe(0.5)
  })
  it('copies the usage fields the gateway sends', () => {
    const m = mergeTurn(turn, {
      taskId: 't1', status: 'succeeded', cost: 0.42, billing: 'api', durationMs: 8200,
      tokens: { input: 1200, output: 300 }, turns: 3, usageLimited: false,
    })
    expect(m).toMatchObject({ cost: 0.42, billing: 'api', durationMs: 8200, tokens: { input: 1200, output: 300 }, turns: 3, usageLimited: false })
  })
  it('keeps the old tool calls when a later poll omits them (absent, not 0)', () => {
    const noTools: ChatTurn = { ...turn, toolCalls: undefined }
    expect(mergeTurn(noTools, { taskId: 't1', status: 'succeeded' }).toolCalls).toBeUndefined()
    expect(mergeTurn(turn, { taskId: 't1', status: 'succeeded' }).toolCalls).toBe(3)
  })
  it('ignores malformed token totals and billing', () => {
    const m = mergeTurn(turn, { taskId: 't1', tokens: { input: '1' } as unknown as { input: number; output: number }, billing: '' })
    expect(m.tokens).toBeUndefined()
    expect(m.billing).toBeUndefined()
  })
  it('keeps the old task id when the new one is empty and overrides other fields', () => {
    const m = mergeTurn(turn, { taskId: '', output: 'new', error: 'boom', model: 'm' })
    expect(m).toMatchObject({ taskId: 't1', output: 'new', error: 'boom', model: 'm', id: 1, message: 'hi' })
  })
  it('keeps the trace id from an earlier poll when a later one omits it', () => {
    const withTrace: ChatTurn = { ...turn, traceId: 'abc123' }
    expect(mergeTurn(withTrace, { taskId: 't1', status: 'succeeded' }).traceId).toBe('abc123')
    expect(mergeTurn(withTrace, { taskId: 't1', traceId: '' }).traceId).toBe('abc123')
  })
  it('takes a trace id that arrives later', () => {
    expect(mergeTurn(turn, { taskId: 't1', traceId: 'def456' }).traceId).toBe('def456')
  })
})
