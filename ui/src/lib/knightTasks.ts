/** Pure helpers for the knight drawer's "Recent work" section (#510). */
import type { Schedule } from './schedules'

/** One row of the recent-tasks list, from the gateway's TaskRecord. */
export interface TaskRow {
  taskId: string
  status: string
  createdAt?: string
  durationMs?: number
  cost?: number
  traceId?: string
}

/** `none` and an empty table both mean no table (#594). */
const normaliseTable = (t: string | undefined): string | undefined => (t && t !== 'none' ? t : undefined)

/**
 * Schedules that wake a knight: knight-kind targets with the same name. When both
 * the knight (ignoring "none") and the schedule have a table, the tables must match.
 */
export function schedulesFor(knight: string, table: string | undefined, schedules: Schedule[] | null | undefined): Schedule[] {
  const kt = normaliseTable(table)
  return (schedules ?? []).filter((s) => {
    const st = normaliseTable(s.table)
    return s.target?.kind === 'knight' && s.target.knight === knight && !(kt && st && st !== kt)
  })
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** Accepts `{tasks: [...]}` or a bare array; drops entries without a task ID. */
export function taskRows(list: unknown): TaskRow[] {
  const raw = Array.isArray(list) ? list : (list as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(raw)) return []
  const rows: TaskRow[] = []
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>
    const taskId = str(o.taskId)
    if (!taskId) continue
    rows.push({
      taskId, status: str(o.status) ?? 'unknown', createdAt: str(o.createdAt),
      durationMs: num(o.durationMs), cost: num(o.cost), traceId: str(o.traceId),
    })
  }
  return rows
}
