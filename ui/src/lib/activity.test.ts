import { describe, it, expect } from 'vitest'
import {
  applyActivityMsg,
  buildTimeline,
  emptyActivity,
  formatMs,
  parseActivityMsg,
  MAX_TIMELINE_ENTRIES,
  type ActivityItem,
  type ActivityState,
} from './activity'

const ev = (type: string, seq: number, extra: Partial<ActivityItem> = {}): ActivityItem => ({ type, seq, ts: '2026-11-24T12:00:00Z', ...extra })

function backlog(events: ActivityItem[], seq?: number, dropped = 0): ActivityState {
  const msg = parseActivityMsg({ op: 'backlog', taskId: 't', task: { taskId: 't', seq: seq ?? 0 }, events, dropped })!
  return applyActivityMsg(emptyActivity, msg)
}

function live(state: ActivityState, item: ActivityItem): ActivityState {
  return applyActivityMsg(state, parseActivityMsg({ op: 'event', taskId: 't', event: item })!)
}

describe('parseActivityMsg', () => {
  it('rejects malformed payloads', () => {
    expect(parseActivityMsg(null)).toBeNull()
    expect(parseActivityMsg({ op: 'nope', taskId: 't' })).toBeNull()
    expect(parseActivityMsg({ op: 'event', taskId: 't' })).toBeNull()
    expect(parseActivityMsg({ op: 'backlog' })).toBeNull()
  })

  it('accepts a backlog without events', () => {
    const msg = parseActivityMsg({ op: 'backlog', taskId: 't' })
    expect(msg).toMatchObject({ op: 'backlog', events: [], dropped: 0 })
  })
})

describe('applyActivityMsg', () => {
  it('turns backlog gaps and live seq jumps into gap markers', () => {
    let s = backlog([ev('task.started', 1), ev('tool.started', 5, { gap: 3 })], 6, 2)
    expect(s.loaded).toBe(true)
    expect(s.dropped).toBe(2)
    expect(s.entries.map((e) => e.kind)).toEqual(['event', 'gap', 'event'])
    expect(s.lastSeq).toBe(6) // a heartbeat (seq 6) came after the last item

    s = live(s, ev('tool.finished', 7))
    expect(s.entries).toHaveLength(4)
    s = live(s, ev('assistant.message', 10))
    const gap = s.entries[4]
    expect(gap).toEqual({ kind: 'gap', missing: 2, afterSeq: 7 })
    expect(s.lastSeq).toBe(10)
  })

  it('keeps heartbeats out of the timeline but uses their seq and header', () => {
    let s = backlog([ev('task.started', 1)], 1)
    s = applyActivityMsg(s, parseActivityMsg({ op: 'event', taskId: 't', task: { taskId: 't', seq: 2, costUsd: 0.5 }, event: ev('task.heartbeat', 2) })!)
    expect(s.entries).toHaveLength(1)
    expect(s.task?.costUsd).toBe(0.5)
    s = live(s, ev('tool.started', 3))
    expect(s.entries.map((e) => e.kind)).toEqual(['event', 'event'])
  })

  it('restarts seq tracking on a redelivered task.started', () => {
    let s = backlog([ev('task.started', 1), ev('tool.started', 40)], 40)
    s = live(s, ev('task.started', 1))
    s = live(s, ev('tool.started', 2))
    expect(s.entries.some((e) => e.kind === 'gap')).toBe(false)
  })

  it('maps server errors to readable text', () => {
    const s = applyActivityMsg(emptyActivity, parseActivityMsg({ op: 'error', taskId: 't', error: 'watch_limit' })!)
    expect(s.error).toMatch(/Too many tasks/)
  })

  it('caps the timeline', () => {
    let s = backlog([], 0)
    for (let i = 1; i <= MAX_TIMELINE_ENTRIES + 5; i++) s = live(s, ev('assistant.message', i))
    expect(s.entries).toHaveLength(MAX_TIMELINE_ENTRIES)
  })
})

describe('buildTimeline', () => {
  it('pairs tool calls and keeps order', () => {
    const s = backlog([
      ev('task.started', 1),
      ev('tool.started', 2, { tool: 'bash', toolCallId: 'a' }),
      ev('assistant.message', 3, { preview: 'hi' }),
      ev('tool.finished', 4, { tool: 'bash', toolCallId: 'a', durationMs: 1500, isError: true }),
      ev('tool.finished', 6, { tool: 'read', toolCallId: 'orphan', gap: 1 }),
    ])
    const rows = buildTimeline(s.entries)
    expect(rows.map((r) => r.kind)).toEqual(['lifecycle', 'tool', 'message', 'gap', 'tool'])
    const tool = rows[1]
    expect(tool.kind === 'tool' && tool.finished?.isError).toBe(true)
    const orphan = rows[4]
    expect(orphan.kind === 'tool' && !orphan.started && orphan.finished?.tool).toBe('read')
  })
})

describe('formatMs', () => {
  it('formats durations', () => {
    expect(formatMs(850)).toBe('850ms')
    expect(formatMs(12_300)).toBe('12.3s')
    expect(formatMs(125_000)).toBe('2m 5s')
    expect(formatMs(undefined)).toBe('')
  })
})
