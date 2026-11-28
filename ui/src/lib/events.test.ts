import { describe, it, expect } from 'vitest'
import { parseEvent, parseEventData, resultFailureReason, uniqueKeys, displayText } from './events'
import { domainIndex } from './knights'
import type { NatsEvent } from '../hooks/useWebSocket'

function makeEvent(type: NatsEvent['type'], subject: string, data: unknown): NatsEvent {
  return { type, subject, data, timestamp: '2026-06-10T12:00:00Z' }
}

describe('parseEvent', () => {
  it('parses result subjects as <fleet>.results.<taskId> with knight from payload', () => {
    const event = makeEvent('result', 'fleet-a.results.galahad-ui-1749500000000', {
      task_id: 'galahad-ui-1749500000000',
      knight: 'Galahad',
      success: true,
      cost: 0.0123,
    })
    const parsed = parseEvent(event)
    expect(parsed.knight).toBe('galahad')
    expect(parsed.domain).toBeNull()
    expect(parsed.taskId).toBe('galahad-ui-1749500000000')
  })

  it('falls back to the subject for taskId when payload lacks task_id', () => {
    const event = makeEvent('result', 'fleet-a.results.task-42', { knight: 'Kay', success: true })
    expect(parseEvent(event).taskId).toBe('task-42')
  })

  it('returns null knight for results without a payload knight field', () => {
    const event = makeEvent('result', 'fleet-a.results.task-42', { success: true })
    expect(parseEvent(event).knight).toBeNull()
  })

  it('parses task subjects as <fleet>.tasks.<domain>.<taskId>', () => {
    const event = makeEvent('task', 'fleet-a.tasks.security.galahad-ui-1', { task: 'scan' })
    const parsed = parseEvent(event)
    expect(parsed.domain).toBe('security')
    expect(parsed.knight).toBe('galahad')
    expect(parsed.taskId).toBe('galahad-ui-1')
  })

  it('handles JSON-string payloads', () => {
    const event = makeEvent('result', 'fleet-a.results.t1', '{"knight":"Tristan","success":false,"result":"boom"}')
    const parsed = parseEvent(event)
    expect(parsed.knight).toBe('tristan')
    expect(parsed.data.success).toBe(false)
  })

  it('lowercases hyphenated knight names to match CR names', () => {
    const event = makeEvent('result', 'fleet-a.results.t2', { knight: 'Coder-1', success: true })
    expect(parseEvent(event).knight).toBe('coder-1')
  })
})

describe('parseEventData', () => {
  it('wraps unparseable strings as raw', () => {
    expect(parseEventData('not json')).toEqual({ raw: 'not json' })
  })

  it('returns empty object for null/undefined', () => {
    expect(parseEventData(null)).toEqual({})
    expect(parseEventData(undefined)).toEqual({})
  })
})

describe('resultFailureReason', () => {
  it('returns null for successful results', () => {
    expect(resultFailureReason({ success: true, result: 'done' })).toBeNull()
    expect(resultFailureReason({})).toBeNull()
  })

  it('extracts the failure text from result (pi-knight has no error field)', () => {
    expect(resultFailureReason({ success: false, result: 'Task failed: timeout' })).toBe('Task failed: timeout')
  })

  it('truncates long failure text', () => {
    const reason = resultFailureReason({ success: false, result: 'x'.repeat(500) })
    expect(reason!.length).toBeLessThanOrEqual(161)
    expect(reason!.endsWith('…')).toBe(true)
  })

  it('falls back to unknown error when result is empty', () => {
    expect(resultFailureReason({ success: false })).toBe('unknown error')
  })
})

describe('payload hardening', () => {
  it('parseEventData gives {} for non-object values and {raw} for non-object strings', () => {
    expect(parseEventData(null)).toEqual({})
    expect(parseEventData(12)).toEqual({})
    expect(parseEventData('null')).toEqual({ raw: 'null' })
    expect(parseEventData('12')).toEqual({ raw: '12' })
    expect(parseEventData('{"a":1}')).toEqual({ a: 1 })
    expect(parseEventData('nope')).toEqual({ raw: 'nope' })
  })
  it('uniqueKeys suffixes repeats only', () => {
    expect(uniqueKeys(['a', 'b', 'a'])).toEqual(['a', 'b', 'a#1'])
  })
  it('displayText bounds and stringifies', () => {
    expect(displayText('x')).toBe('x')
    expect(displayText({ a: 1 })).toBe('{"a":1}')
    expect(displayText('y'.repeat(400))).toHaveLength(301)
    expect(displayText(undefined)).toBe('')
  })
})

describe('parseEvent with a fleet domain index', () => {
  const task = (domain: string) => ({ type: 'task', subject: `fleet.tasks.${domain}.t1`, data: {}, timestamp: '2026-01-01T00:00:00Z' }) as NatsEvent
  it('attributes a task to a knight outside the built-in table', () => {
    expect(parseEvent(task('ui')).knight).toBeNull()
    expect(parseEvent(task('ui'), new Map([['ui', 'rt-ui']])).knight).toBe('rt-ui')
  })
  it('gives no attribution for a domain shared by several knights', () => {
    expect(parseEvent(task('coding'), domainIndex([{ name: 'a', domain: 'coding' }, { name: 'b', domain: 'coding' }])).knight).toBeNull()
  })
})
