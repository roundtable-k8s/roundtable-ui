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

/** Schedules that wake `knight`: a knight target of that name, or a table with one. */
export function schedulesFor(knight: string, schedules: Schedule[] | null | undefined): Schedule[] {
  return (schedules ?? []).filter((s) => s.target?.knight === knight && (s.target.kind === 'knight' || s.target.kind === 'table' || !!s.table))
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
