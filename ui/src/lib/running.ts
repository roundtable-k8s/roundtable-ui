import { formatSecondsLadder } from './format'
/**
 * In-flight task registry as seen by the browser (#183, #200).
 *
 * Contract with the API (#199):
 *  - GET /api/running → `{ tasks: RunningTask[] }` (a bare array is also accepted).
 *  - WS message `{ type: "running", data: RunningDelta }` on /api/ws.
 *
 * Field names follow the task activity event contract
 * (roundtable-k8s/roundtable#249, pkg/nats ActivityEvent).
 */

export type RunningStatus = 'running' | 'stale' | 'lost'

export interface RunningToolEvent {
  tool: string
  /** tool.started / tool.finished */
  type?: string
  argsSummary?: string
  isError?: boolean
  durationMs?: number
  ts?: string
}

export interface RunningTask {
  /** RoundTable the object belongs to; "none" when unset. List endpoints accept ?table=<name>. */
  table?: string
  taskId: string
  knight: string
  pod?: string
  node?: string
  slot?: number
  concurrency?: number
  runId?: string
  chainName?: string
  stepName?: string
  model?: string
  status: RunningStatus
  /** Why the task is stale/lost (e.g. "pod deleted", "max deliveries"). */
  reason?: string
  /** RFC 3339 time of task.started. */
  startedAt: string
  /** RFC 3339 time of the last heartbeat (or task.started). */
  lastHeartbeat?: string
  turns?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  currentTool?: string
  lastTool?: RunningToolEvent
}

export type RunningDelta =
  | { op: 'snapshot'; tasks: RunningTask[] }
  | { op: 'upsert'; task: RunningTask }
  | { op: 'remove'; taskId: string }

export type RunningMap = ReadonlyMap<string, RunningTask>

const STATUSES: RunningStatus[] = ['running', 'stale', 'lost']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate one task from the wire; drops entries without taskId/knight. */
export function toRunningTask(v: unknown): RunningTask | null {
  if (!isObject(v)) return null
  if (typeof v.taskId !== 'string' || !v.taskId) return null
  if (typeof v.knight !== 'string' || !v.knight) return null
  const status = STATUSES.includes(v.status as RunningStatus) ? (v.status as RunningStatus) : 'running'
  const lastTool = isObject(v.lastTool) && typeof v.lastTool.tool === 'string'
    ? (v.lastTool as unknown as RunningToolEvent)
    : undefined
  return {
    ...(v as unknown as RunningTask),
    status,
    startedAt: typeof v.startedAt === 'string' ? v.startedAt : '',
    lastTool,
  }
}

function toTaskList(v: unknown): RunningTask[] {
  const list = Array.isArray(v) ? v : isObject(v) && Array.isArray(v.tasks) ? v.tasks : []
  return list.map(toRunningTask).filter((t): t is RunningTask => t !== null)
}

/** Parse the GET /api/running response into a map keyed by taskId. */
export function parseRunningResponse(body: unknown): Map<string, RunningTask> {
  return new Map(toTaskList(body).map((t) => [t.taskId, t]))
}

/** Parse a `running` WS payload; returns null for anything unrecognised. */
export function parseRunningDelta(data: unknown): RunningDelta | null {
  if (!isObject(data)) return null
  switch (data.op) {
    case 'snapshot':
      return { op: 'snapshot', tasks: toTaskList(data.tasks) }
    case 'upsert': {
      const task = toRunningTask(data.task)
      return task ? { op: 'upsert', task } : null
    }
    case 'remove':
      return typeof data.taskId === 'string' && data.taskId ? { op: 'remove', taskId: data.taskId } : null
    default:
      return null
  }
}

/** Apply a delta immutably. Returns the same map when nothing changed. */
export function applyRunningDelta(prev: RunningMap, delta: RunningDelta): RunningMap {
  switch (delta.op) {
    case 'snapshot':
      return new Map(delta.tasks.map((t) => [t.taskId, t]))
    case 'upsert': {
      const next = new Map(prev)
      // Keep the known table when an update doesn't carry one, or carries the
      // untabled sentinel "none" while the task already has a real table.
      const incoming = delta.task.table
      const known = prev.get(delta.task.taskId)?.table
      const table = incoming && incoming !== 'none'
        ? incoming
        : known && known !== 'none' ? known : incoming
      next.set(delta.task.taskId, table ? { ...delta.task, table } : delta.task)
      return next
    }
    case 'remove': {
      if (!prev.has(delta.taskId)) return prev
      const next = new Map(prev)
      next.delete(delta.taskId)
      return next
    }
  }
}

export interface RunningFilter {
  knight?: string
  chain?: string
  status?: RunningStatus | ''
}

/** Filter and sort (oldest first — long runners float to the top). */
export function filterRunning(tasks: Iterable<RunningTask>, f: RunningFilter): RunningTask[] {
  return [...tasks]
    .filter((t) => !f.knight || t.knight === f.knight)
    .filter((t) => !f.chain || t.chainName === f.chain)
    .filter((t) => !f.status || t.status === f.status)
    .sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || '') || a.taskId.localeCompare(b.taskId))
}

export function countByStatus(tasks: Iterable<RunningTask>): Record<RunningStatus, number> {
  const counts: Record<RunningStatus, number> = { running: 0, stale: 0, lost: 0 }
  for (const t of tasks) counts[t.status]++
  return counts
}

/** "12s" / "4m 3s" / "2h 5m" from an ISO timestamp to `now`. */
export function formatAge(iso: string | undefined, now: number): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const sec = Math.max(0, Math.floor((now - t) / 1000))
  return formatSecondsLadder(sec)
}
