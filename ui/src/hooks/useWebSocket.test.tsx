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
  constructor() { FakeWS.last = this }
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
