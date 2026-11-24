import { describe, it, expect } from 'vitest'
import { mergePodLogs, parseTimestampedLine, podColor, podLogsUrl, shortPodName, POD_COLORS } from './podLogs'

describe('podLogsUrl', () => {
  it('omits unset params', () => {
    expect(podLogsUrl('galahad')).toBe('/api/fleet/galahad/logs')
  })
  it('adds pod, container, previous and timestamps', () => {
    expect(podLogsUrl('galahad', { pod: 'galahad-a-1', container: 'knight', previous: true, timestamps: true }))
      .toBe('/api/fleet/galahad/logs?pod=galahad-a-1&container=knight&previous=true&timestamps=true')
  })
  it('drops previous=false', () => {
    expect(podLogsUrl('galahad', { pod: 'p', previous: false })).toBe('/api/fleet/galahad/logs?pod=p')
  })
})

describe('shortPodName', () => {
  it('strips the knight prefix', () => {
    expect(shortPodName('galahad-7d9f-x2k', 'Galahad')).toBe('7d9f-x2k')
    expect(shortPodName('other-1', 'galahad')).toBe('other-1')
  })
})

describe('podColor', () => {
  it('cycles the palette', () => {
    expect(podColor(0)).toBe(POD_COLORS[0])
    expect(podColor(POD_COLORS.length)).toBe(POD_COLORS[0])
  })
})

describe('parseTimestampedLine', () => {
  it('splits the timestamp', () => {
    expect(parseTimestampedLine('2026-11-24T10:00:00.123456789Z hello world')).toEqual({
      ts: Date.parse('2026-11-24T10:00:00.123456789Z'),
      text: 'hello world',
    })
  })
  it('keeps lines without a timestamp', () => {
    expect(parseTimestampedLine('  at foo()')).toEqual({ ts: null, text: '  at foo()' })
  })
})

describe('mergePodLogs', () => {
  it('interleaves pods by time and keeps continuation lines together', () => {
    const merged = mergePodLogs([
      { pod: 'a', text: '2026-11-24T10:00:01Z a1\n2026-11-24T10:00:03Z a2\n  trace\n' },
      { pod: 'b', text: '2026-11-24T10:00:02Z b1\n2026-11-24T10:00:04Z b2\n' },
    ])
    expect(merged.map((l) => `${l.pod}:${l.text}`)).toEqual(['a:a1', 'b:b1', 'a:a2', 'a:  trace', 'b:b2'])
  })
  it('skips empty lines', () => {
    expect(mergePodLogs([{ pod: 'a', text: '\n\n' }])).toEqual([])
  })
})
