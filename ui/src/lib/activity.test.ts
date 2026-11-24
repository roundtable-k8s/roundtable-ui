import { describe, it, expect } from 'vitest'
import {
  applyActivityMessage,
  buildTimeline,
  elapsedMs,
  formatMs,
  initialActivityState,
  MAX_CLIENT_EVENTS,
  summarizeActivity,
  type ActivityState,
} from './activity'

const T = 't1'
const ev = (seq: number, type: string, extra: Record<string, unknown> = {}) => ({
  v: 1, type, seq, taskId: T, knight: 'Galahad', pod: 'galahad-abc', ts: `2026-11-24T10:00:${String(seq).padStart(2, '0')}.000Z`, ...extra,
})

function apply(state: ActivityState, ...msgs: unknown[]): ActivityState {
  return msgs.reduce<ActivityState>((s, m) => applyActivityMessage(s, m, T), state)
}

describe('applyActivityMessage', () => {
  it('loads the backlog, then appends live events in seq order without duplicates', () => {
    let s = apply(initialActivityState, { op: 'backlog', taskId: T, events: [ev(2, 'tool.started'), ev(1, 'task.started')] })
    expect(s.loaded).toBe(true)
    expect(s.events.map((e) => e.seq)).toEqual([1, 2])
    s = apply(s, { op: 'event', taskId: T, event: ev(3, 'tool.finished') })
    s = apply(s, { op: 'event', taskId: T, event: ev(3, 'tool.finished') })
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3])
    // late reordered event slots into place
    s = apply(s, { op: 'event', taskId: T, event: ev(5, 'assistant.message') }, { op: 'event', taskId: T, event: ev(4, 'task.heartbeat') })
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
  })

  it('ignores other tasks and malformed events', () => {
    const s = apply(
      initialActivityState,
      { op: 'backlog', taskId: 'other', events: [ev(1, 'task.started')] },
      { op: 'event', taskId: T, event: { type: 'tool.started' } },
      { op: 'event', taskId: T, event: { ...ev(1, 'task.started'), taskId: 'other' } },
      'garbage',
    )
    expect(s).toEqual(initialActivityState)
  })

  it('a fresh backlog replaces earlier state (re-subscribe after reconnect)', () => {
    let s = apply(initialActivityState, { op: 'backlog', taskId: T, events: [ev(1, 'task.started')] }, { op: 'gap', taskId: T, fromSeq: 2, toSeq: 3 })
    s = apply(s, { op: 'backlog', taskId: T, events: [ev(1, 'task.started'), ev(2, 'tool.started')], truncated: 0 })
    expect(s.events).toHaveLength(2)
    expect(s.serverGaps).toEqual([])
  })

  it('marks finished from the backlog flag or a task.finished event', () => {
    expect(apply(initialActivityState, { op: 'backlog', taskId: T, events: [], finished: true }).finished).toBe(true)
    const s = apply(initialActivityState, { op: 'backlog', taskId: T, events: [] }, { op: 'event', taskId: T, event: ev(1, 'task.finished') })
    expect(s.finished).toBe(true)
  })

  it('records errors', () => {
    const s = apply(initialActivityState, { op: 'error', taskId: T, error: 'too many watched tasks' })
    expect(s.error).toBe('too many watched tasks')
  })

  it('caps kept events and counts the dropped ones as truncated', () => {
    const events = Array.from({ length: MAX_CLIENT_EVENTS + 5 }, (_, i) => ev(i + 1, 'task.heartbeat'))
    const s = apply(initialActivityState, { op: 'backlog', taskId: T, events, truncated: 2 })
    expect(s.events).toHaveLength(MAX_CLIENT_EVENTS)
    expect(s.events[0].seq).toBe(6)
    expect(s.truncated).toBe(7)
  })
})

describe('buildTimeline', () => {
  it('pairs tool calls, keeps messages and skips heartbeats', () => {
    const s = apply(initialActivityState, {
      op: 'backlog', taskId: T, events: [
        ev(1, 'task.started'),
        ev(2, 'assistant.message', { preview: 'Let me look' }),
        ev(3, 'tool.started', { tool: 'Bash', toolCallId: 'c1', argsSummary: 'ls' }),
        ev(4, 'task.heartbeat', { currentTool: 'Bash' }),
        ev(5, 'tool.finished', { tool: 'Bash', toolCallId: 'c1', durationMs: 1200, isError: true, outputPreview: 'boom' }),
        ev(6, 'task.finished', { success: true }),
      ],
    })
    const items = buildTimeline(s)
    expect(items.map((i) => i.kind)).toEqual(['started', 'message', 'tool', 'finished'])
    const tool = items[2]
    expect(tool.kind === 'tool' && tool.finished?.durationMs).toBe(1200)
    expect(tool.kind === 'tool' && tool.finished?.isError).toBe(true)
  })

  it('shows a gap marker for a seq jump and a truncation marker for evicted events', () => {
    const s = apply(initialActivityState, {
      op: 'backlog', taskId: T, truncated: 10, events: [ev(11, 'assistant.message'), ev(14, 'assistant.message')],
    })
    const items = buildTimeline(s)
    expect(items[0]).toMatchObject({ kind: 'truncated', count: 10 })
    expect(items[2]).toMatchObject({ kind: 'gap', fromSeq: 12, toSeq: 13 })
  })

  it('shows a leading gap when the first events never arrived', () => {
    const s = apply(initialActivityState, { op: 'backlog', taskId: T, events: [ev(3, 'assistant.message')] })
    expect(buildTimeline(s)[0]).toMatchObject({ kind: 'gap', fromSeq: 1, toSeq: 2 })
  })

  it('shows a server gap until a later event brackets it, without double-counting', () => {
    let s = apply(initialActivityState, { op: 'backlog', taskId: T, events: [ev(1, 'task.started')] }, { op: 'gap', taskId: T, fromSeq: 2, toSeq: 4, count: 3 })
    expect(buildTimeline(s).filter((i) => i.kind === 'gap')).toEqual([{ kind: 'gap', key: 'sgap-2', fromSeq: 2, toSeq: 4 }])
    s = apply(s, { op: 'event', taskId: T, event: ev(5, 'assistant.message') })
    expect(buildTimeline(s).filter((i) => i.kind === 'gap')).toEqual([{ kind: 'gap', key: 'gap-2', fromSeq: 2, toSeq: 4 }])
  })
})

describe('summary', () => {
  it('takes the latest header values and the finished duration', () => {
    const events = [
      ev(1, 'task.started', { model: 'opus', chainName: 'c', stepName: 's', runId: 'r1' }),
      ev(2, 'task.heartbeat', { costUsd: 0.1, currentTool: 'Bash' }),
      ev(3, 'task.finished', { costUsd: 0.25, durationMs: 65_000, success: false, errorClass: 'timeout' }),
    ]
    const s = summarizeActivity(events.map((e) => ({ ...e })))
    expect(s).toMatchObject({ knight: 'Galahad', pod: 'galahad-abc', model: 'opus', runId: 'r1', costUsd: 0.25, success: false, errorClass: 'timeout' })
    expect(s.currentTool).toBeUndefined()
    expect(elapsedMs(s, Date.now())).toBe(65_000)
    expect(formatMs(65_000)).toBe('1m 5s')
  })

  it('computes elapsed from the start time while running', () => {
    const now = Date.parse('2026-11-24T10:00:31.000Z')
    expect(elapsedMs({ startedAt: '2026-11-24T10:00:01.000Z' }, now)).toBe(30_000)
    expect(formatMs(850)).toBe('850ms')
    expect(formatMs(4200)).toBe('4.2s')
    expect(formatMs(undefined)).toBe('—')
  })
})
