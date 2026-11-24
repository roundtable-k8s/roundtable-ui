// RoundTable helpers for the Tasks page (#239). The API discovers every
// RoundTable and tags task/result events with the table they came from.
import type { NatsEvent } from '../hooks/useWebSocket'
import { parseEvent } from './events'

export interface TableInfo {
  name: string
  prefix: string
  tasksStream?: string
  resultsStream?: string
}

/** The table a knight belongs to, matched on its NATS prefix. */
export function tableForKnight(natsPrefix: string | undefined, tables: TableInfo[]): TableInfo | undefined {
  if (!natsPrefix) return undefined
  return tables.find((t) => t.prefix === natsPrefix)
}

/** The table that owns a subject (longest prefix wins). */
export function tableForSubject(subject: string, tables: TableInfo[]): TableInfo | undefined {
  let best: TableInfo | undefined
  for (const t of tables) {
    if (subject.startsWith(t.prefix + '.') && (!best || t.prefix.length > best.prefix.length)) best = t
  }
  return best
}

/** An event's table: the API label, else derived from its subject. */
export function eventTable(event: NatsEvent, tables: TableInfo[]): string {
  return event.table || tableForSubject(event.subject, tables)?.name || ''
}

export interface TaskRow {
  key: string
  type: 'task' | 'result'
  taskId: string
  knight: string | null
  table: string
  success: boolean | null
  text: string
  timestamp: string
}

/** Task/result events as Tasks-page rows, newest first, optionally one table only. */
export function taskRows(events: NatsEvent[], tables: TableInfo[], table = ''): TaskRow[] {
  const rows: TaskRow[] = []
  for (const e of events) {
    if (e.type !== 'task' && e.type !== 'result') continue
    const t = eventTable(e, tables)
    if (table && t !== table) continue
    const p = parseEvent(e)
    const raw = e.type === 'task' ? p.data.task : p.data.result
    rows.push({
      key: `${e.subject}:${e.timestamp}`,
      type: e.type,
      taskId: p.taskId,
      knight: p.knight,
      table: t,
      success: e.type === 'result' ? p.data.success !== false : null,
      text: typeof raw === 'string' ? raw : '',
      timestamp: e.timestamp,
    })
  }
  return rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
}
