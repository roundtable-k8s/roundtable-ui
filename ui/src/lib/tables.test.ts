import { describe, it, expect } from 'vitest'
import { tableForKnight, tableForSubject, eventTable, taskRows, type TableInfo } from './tables'
import type { NatsEvent } from '../hooks/useWebSocket'

const tables: TableInfo[] = [
  { name: 'fleet-a', prefix: 'fleet-a' },
  { name: 'roundtable-dev', prefix: 'rt-dev' },
]

const events: NatsEvent[] = [
  { type: 'result', subject: 'fleet-a.results.t1', table: 'fleet-a', timestamp: '2026-11-24T10:00:00Z',
    data: { task_id: 't1', knight: 'Galahad', success: true, result: 'scan clean' } },
  { type: 'task', subject: 'rt-dev.tasks.ui.t2', timestamp: '2026-11-24T10:02:00Z',
    data: { task_id: 't2', task: 'fix the page' } },
  { type: 'result', subject: 'rt-dev.results.t3', table: 'roundtable-dev', timestamp: '2026-11-24T10:01:00Z',
    data: { task_id: 't3', knight: 'Rt-ui', success: false, result: 'boom' } },
  { type: 'chain', subject: 'chain', timestamp: '2026-11-24T10:03:00Z', data: {} },
]

describe('tables', () => {
  it('matches a knight to its table by prefix', () => {
    expect(tableForKnight('rt-dev', tables)?.name).toBe('roundtable-dev')
    expect(tableForKnight('chelonian', tables)).toBeUndefined()
    expect(tableForKnight(undefined, tables)).toBeUndefined()
  })

  it('derives a table from a subject, longest prefix first', () => {
    const nested = [...tables, { name: 'sub', prefix: 'rt-dev.sub' }]
    expect(tableForSubject('rt-dev.sub.tasks.x.y', nested)?.name).toBe('sub')
    expect(tableForSubject('rt-devx.tasks.x.y', nested)).toBeUndefined()
  })

  it('prefers the API label over the subject', () => {
    expect(eventTable({ ...events[1], table: 'other' }, tables)).toBe('other')
    expect(eventTable(events[1], tables)).toBe('roundtable-dev')
  })

  it('builds newest-first rows from both tables, each labelled', () => {
    const rows = taskRows(events, tables)
    expect(rows.map((r) => [r.taskId, r.table, r.type])).toEqual([
      ['t2', 'roundtable-dev', 'task'],
      ['t3', 'roundtable-dev', 'result'],
      ['t1', 'fleet-a', 'result'],
    ])
    expect(rows[1]).toMatchObject({ knight: 'rt-ui', success: false, text: 'boom' })
    expect(rows[0]).toMatchObject({ success: null, text: 'fix the page' })
  })

  it('filters rows to one table', () => {
    expect(taskRows(events, tables, 'fleet-a').map((r) => r.taskId)).toEqual(['t1'])
  })
})
