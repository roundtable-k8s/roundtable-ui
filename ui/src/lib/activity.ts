/**
 * Live task activity stream as seen by the browser (#184).
 *
 * Contract with the API (api/activity.go):
 *  - client → `{"subscribe":"activity","taskId":"…"}` / `{"unsubscribe":"activity","taskId":"…"}`
 *  - server → `{ type: "activity", data: ActivityMsg }`: first a `backlog`
 *    (the last 200 events, heartbeats excluded), then live `event`s.
 *
 * Every event carries the knight's per-task `seq`. Live gaps (events lost on
 * the way or dropped for a slow client) are spotted on the client; backlog
 * items carry the gap the API saw in `gap`.
 */

export interface ActivityItem {
  type: string
  ts: string
  seq: number
  gap?: number
  truncated?: boolean
  tool?: string
  toolCallId?: string
  argsSummary?: string
  durationMs?: number
  isError?: boolean
  outputPreview?: string
  preview?: string
  turns?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  currentTool?: string
  success?: boolean
  errorClass?: string
}

export interface ActivityTaskInfo {
  taskId: string
  knight?: string
  pod?: string
  node?: string
  runId?: string
  chainName?: string
  stepName?: string
  model?: string
  startedAt?: string
  lastEventAt?: string
  seq: number
  turns?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  finished?: boolean
  success?: boolean
  errorClass?: string
  durationMs?: number
  finishedAt?: string
}

export type ActivityMsg =
  | { op: 'backlog'; taskId: string; task?: ActivityTaskInfo; events: ActivityItem[]; dropped?: number }
  | { op: 'event'; taskId: string; task?: ActivityTaskInfo; event: ActivityItem }
  | { op: 'error'; taskId: string; error: string }

export type TimelineEntry =
  | { kind: 'event'; item: ActivityItem }
  | { kind: 'gap'; missing: number; afterSeq: number }

export interface ActivityState {
  task?: ActivityTaskInfo
  entries: TimelineEntry[]
  /** Events that fell out of the API's ring buffer before the backlog. */
  dropped: number
  lastSeq: number
  /** The backlog has arrived. */
  loaded: boolean
  error?: string
}

/** Most timeline entries kept in the browser per task. */
export const MAX_TIMELINE_ENTRIES = 1000

export const emptyActivity: ActivityState = { entries: [], dropped: 0, lastSeq: 0, loaded: false }

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toItem(v: unknown): ActivityItem | null {
  if (!isObject(v) || typeof v.type !== 'string') return null
  return {
    ...(v as unknown as ActivityItem),
    ts: typeof v.ts === 'string' ? v.ts : '',
    seq: typeof v.seq === 'number' ? v.seq : 0,
  }
}

function toTask(v: unknown): ActivityTaskInfo | undefined {
  if (!isObject(v) || typeof v.taskId !== 'string') return undefined
  return { ...(v as unknown as ActivityTaskInfo), seq: typeof v.seq === 'number' ? v.seq : 0 }
}

/** Validate an `activity` WS payload. */
export function parseActivityMsg(v: unknown): ActivityMsg | null {
  if (!isObject(v) || typeof v.op !== 'string') return null
  const taskId = typeof v.taskId === 'string' ? v.taskId : ''
  switch (v.op) {
    case 'backlog': {
      if (!taskId) return null
      const events = Array.isArray(v.events) ? v.events.map(toItem).filter((e): e is ActivityItem => !!e) : []
      return { op: 'backlog', taskId, task: toTask(v.task), events, dropped: typeof v.dropped === 'number' ? v.dropped : 0 }
    }
    case 'event': {
      const event = toItem(v.event)
      if (!taskId || !event) return null
      return { op: 'event', taskId, task: toTask(v.task), event }
    }
    case 'error':
      return { op: 'error', taskId, error: typeof v.error === 'string' ? v.error : 'error' }
    default:
      return null
  }
}

function cap(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.length > MAX_TIMELINE_ENTRIES ? entries.slice(entries.length - MAX_TIMELINE_ENTRIES) : entries
}

const ERROR_TEXT: Record<string, string> = {
  watch_limit: 'Too many tasks are being watched from this browser. Close another activity panel and reopen this one.',
  rate_limited: 'Subscribing too fast; reopen the panel in a moment.',
  invalid_task_id: 'This task id cannot be watched.',
}

/** Apply one message of the watched task to the panel state. */
export function applyActivityMsg(state: ActivityState, msg: ActivityMsg): ActivityState {
  switch (msg.op) {
    case 'error':
      return { ...state, error: ERROR_TEXT[msg.error] ?? msg.error }
    case 'backlog': {
      const entries: TimelineEntry[] = []
      let maxSeq = 0
      for (const item of msg.events) {
        if (item.gap && item.gap > 0) entries.push({ kind: 'gap', missing: item.gap, afterSeq: item.seq - item.gap - 1 })
        entries.push({ kind: 'event', item })
        maxSeq = Math.max(maxSeq, item.seq)
      }
      return {
        task: msg.task ?? state.task,
        entries: cap(entries),
        dropped: msg.dropped ?? 0,
        lastSeq: msg.task?.seq || maxSeq,
        loaded: true,
      }
    }
    case 'event': {
      const { event } = msg
      let entries = state.entries
      let lastSeq = state.lastSeq
      if (event.type === 'task.started') {
        lastSeq = event.seq // a (re)delivery starts a new seq run
      } else if (event.seq > 0) {
        if (lastSeq > 0 && event.seq > lastSeq + 1) {
          entries = [...entries, { kind: 'gap', missing: event.seq - lastSeq - 1, afterSeq: lastSeq }]
        }
        lastSeq = Math.max(lastSeq, event.seq)
      }
      if (event.type !== 'task.heartbeat') entries = [...entries, { kind: 'event', item: event }]
      return { ...state, task: msg.task ?? state.task, entries: cap(entries), lastSeq }
    }
  }
}

/** One rendered timeline row: tool calls are folded start+finish. */
export type TimelineRow =
  | { kind: 'tool'; key: string; started?: ActivityItem; finished?: ActivityItem }
  | { kind: 'message'; key: string; item: ActivityItem }
  | { kind: 'lifecycle'; key: string; item: ActivityItem }
  | { kind: 'gap'; key: string; missing: number }

/** Fold timeline entries into rows, pairing tool.started with its tool.finished. */
export function buildTimeline(entries: TimelineEntry[]): TimelineRow[] {
  const rows: TimelineRow[] = []
  const openTools = new Map<string, number>() // toolCallId (or tool name) → row index
  entries.forEach((e, i) => {
    if (e.kind === 'gap') {
      rows.push({ kind: 'gap', key: `gap-${i}`, missing: e.missing })
      return
    }
    const { item } = e
    const key = `${item.type}-${item.seq}-${i}`
    switch (item.type) {
      case 'tool.started': {
        rows.push({ kind: 'tool', key, started: item })
        openTools.set(item.toolCallId || `name:${item.tool ?? ''}`, rows.length - 1)
        break
      }
      case 'tool.finished': {
        const id = item.toolCallId || `name:${item.tool ?? ''}`
        const idx = openTools.get(id)
        const row = idx != null ? rows[idx] : undefined
        if (row && row.kind === 'tool') {
          rows[idx!] = { ...row, finished: item }
          openTools.delete(id)
        } else {
          rows.push({ kind: 'tool', key, finished: item })
        }
        break
      }
      case 'assistant.message':
        rows.push({ kind: 'message', key, item })
        break
      default:
        rows.push({ kind: 'lifecycle', key, item })
    }
  })
  return rows
}

/** Human duration for milliseconds: 850ms, 12.3s, 2m 5s. */
export function formatMs(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}
