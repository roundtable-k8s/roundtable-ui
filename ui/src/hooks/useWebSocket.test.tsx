import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { WebSocketProvider, useWebSocket } from './useWebSocket'

vi.mock('../lib/api', () => ({ apiGet: vi.fn(() => Promise.resolve({ results: [] })) }))

class FakeWS {
  static last: FakeWS
  onopen: (() => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  readyState = 0
  sent: string[] = []
  constructor() { FakeWS.last = this }
  send(d: string) { this.sent.push(d) }
  close() {}
}

beforeEach(() => { vi.stubGlobal('WebSocket', FakeWS) })
afterEach(() => { vi.unstubAllGlobals() })

const wrapper = ({ children }: { children: ReactNode }) => <WebSocketProvider>{children}</WebSocketProvider>

describe('useWebSocket topics', () => {
  it('routes running messages to topic listeners, not the event feed', async () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper })
    const seen: unknown[] = []
    let unsub!: () => void
    act(() => { unsub = result.current.subscribeTopic('running', (d) => seen.push(d)) })

    act(() => FakeWS.last.onmessage!({ data: JSON.stringify({ type: 'running', data: { op: 'remove', taskId: 't1' } }) }))
    act(() => FakeWS.last.onmessage!({ data: JSON.stringify({ type: 'task', subject: 'p.tasks.x', data: {}, timestamp: '2026-11-24T10:00:00Z' }) }))

    expect(seen).toEqual([{ op: 'remove', taskId: 't1' }])
    expect(result.current.events.map((e) => e.type)).toEqual(['task'])

    unsub()
    act(() => FakeWS.last.onmessage!({ data: JSON.stringify({ type: 'running', data: { op: 'remove', taskId: 't2' } }) }))
    expect(seen).toHaveLength(1)
  })
})

describe('useWebSocket chain topic', () => {
  it('routes chain messages to listeners with the envelope (op), not the feed', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper })
    const seen: Array<[unknown, unknown]> = []
    act(() => { result.current.subscribeTopic('chain', (d, msg) => seen.push([d, msg.op])) })
    act(() => FakeWS.last.onmessage!({ data: JSON.stringify({ type: 'chain', subject: 'chains.pr', op: 'delete', data: { name: 'pr' }, timestamp: '2026-11-24T10:00:00Z' }) }))
    expect(seen).toEqual([[{ name: 'pr' }, 'delete']])
    expect(result.current.events).toHaveLength(0)
  })
})

describe('useWebSocket cards topic', () => {
  it('routes card changes to listeners, not the feed', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper })
    const seen: Array<[unknown, unknown]> = []
    act(() => { result.current.subscribeTopic('cards', (d, msg) => seen.push([d, msg.op])) })
    const data = { table: 'personal', knight: 'galahad', deleted: true }
    act(() => FakeWS.last.onmessage!({ data: JSON.stringify({ type: 'cards', subject: 'cards.personal.galahad', op: 'delete', table: 'personal', data, timestamp: '2026-11-24T10:00:00Z' }) }))
    expect(seen).toEqual([[data, 'delete']])
    expect(result.current.events).toHaveLength(0)
  })
})

describe('useWebSocket activity', () => {
  it('routes activity messages to listeners and sends commands only when open', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper })
    const seen: unknown[] = []
    act(() => { result.current.subscribeTopic('activity', (d) => seen.push(d)) })

    expect(result.current.send({ subscribe: 'activity', taskId: 't1' })).toBe(false)
    FakeWS.last.readyState = 1
    expect(result.current.send({ subscribe: 'activity', taskId: 't1' })).toBe(true)
    expect(FakeWS.last.sent).toEqual([JSON.stringify({ subscribe: 'activity', taskId: 't1' })])

    act(() => FakeWS.last.onmessage!({ data: JSON.stringify({ type: 'activity', subject: 'activity', data: { op: 'unsubscribed', taskId: 't1' }, timestamp: '2026-11-24T10:00:00Z' }) }))
    expect(seen).toEqual([{ op: 'unsubscribed', taskId: 't1' }])
    expect(result.current.events).toHaveLength(0)
  })
})
