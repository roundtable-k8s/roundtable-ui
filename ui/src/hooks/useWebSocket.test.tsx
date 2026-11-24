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
  sent: unknown[] = []
  constructor() { FakeWS.last = this }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  open() { this.readyState = 1; this.onopen?.() }
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

describe('useWebSocket activity watches', () => {
  it('subscribes once per task, routes only that task, and renews after reconnect', () => {
    const { result } = renderHook(() => useWebSocket(), { wrapper })
    act(() => FakeWS.last.open())
    const ws1 = FakeWS.last
    const a: unknown[] = []
    const b: unknown[] = []
    let releaseA1!: () => void
    let releaseA2!: () => void
    let releaseB!: () => void
    act(() => {
      releaseA1 = result.current.watchActivity('task-a', (d) => a.push(d))
      releaseA2 = result.current.watchActivity('task-a', () => {})
      releaseB = result.current.watchActivity('task-b', (d) => b.push(d))
    })
    expect(ws1.sent).toEqual([
      { subscribe: 'activity', taskId: 'task-a' },
      { subscribe: 'activity', taskId: 'task-b' },
    ])

    act(() => ws1.onmessage!({ data: JSON.stringify({ type: 'activity', data: { op: 'event', taskId: 'task-a', event: { type: 'tool.started', seq: 2 } } }) }))
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(0)
    expect(result.current.events).toHaveLength(0)

    act(() => releaseA1())
    expect(ws1.sent).toHaveLength(2) // another watcher still holds task-a
    act(() => releaseA2())
    expect(ws1.sent[2]).toEqual({ unsubscribe: 'activity', taskId: 'task-a' })

    // Reconnect: the remaining watch is renewed on the new socket.
    vi.useFakeTimers()
    try {
      act(() => ws1.onclose!({ code: 1006, reason: '' }))
      act(() => { vi.advanceTimersByTime(60_000) })
    } finally {
      vi.useRealTimers()
    }
    expect(FakeWS.last).not.toBe(ws1)
    act(() => FakeWS.last.open())
    expect(FakeWS.last.sent).toEqual([{ subscribe: 'activity', taskId: 'task-b' }])
    act(() => releaseB())
  })
})
