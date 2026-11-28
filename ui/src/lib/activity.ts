/**
 * Live task activity stream as seen by the browser (#184, #214).
 *
 * Events follow the task activity event contract
 * (roundtable-k8s/roundtable docs/design/task-activity-events.md, v1).
 * The API (#213) relays them over /api/ws as `{type: "activity", data}` where
 * data is an ActivityMessage:
 *
 *   → {"subscribe":"activity","taskId":"…"}
 *   ← {op:"backlog", taskId, events, truncated, finished}
 *   ← {op:"event",   taskId, event}
 *   ← {op:"gap",     taskId, fromSeq, toSeq, count}
 *   → {"unsubscribe":"activity","taskId":"…"}
 *   ← {op:"unsubscribed", taskId} | {op:"error", taskId, error}
 *
 * Everything in an event is attacker-influenced text: render it with
 * UntrustedText / sanitizeText only (#188).
 */
import { formatMsLadder } from './format'

type ActivityType =
  | 'task.started'
  | 'task.heartbeat'
  | 'tool.started'
  | 'tool.finished'
  | 'assistant.message'
  | 'task.finished'

export interface ActivityEvent {
  v?: number
  type: string
  ts?: string
  knight?: string
  pod?: string
  node?: string
  taskId: string
  runId?: string
  chainName?: string
  stepName?: string
  model?: string
  seq: number
  truncated?: boolean
  // task.started
  slot?: number
  concurrency?: number
  queuedFor?: number
  // task.heartbeat / task.finished
  turns?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  currentTool?: string
  // tool.*
  tool?: string
  toolCallId?: string
  argsSummary?: string
  durationMs?: number
  isError?: boolean
  outputPreview?: string
  // assistant.message
  preview?: string
  // task.finished
  success?: boolean
  errorClass?: string
}

export type ActivityMessage =
  | { op: 'backlog'; taskId: string; events?: unknown[]; truncated?: number; finished?: boolean }
  | { op: 'event'; taskId: string; event: unknown }
  | { op: 'gap'; taskId: string; fromSeq: number; toSeq: number; count?: number }
  | { op: 'unsubscribed'; taskId: string }
  | { op: 'error'; taskId?: string; error?: string }

/** Client-side cap on kept events per task (the API ring keeps 200). */
export const MAX_CLIENT_EVENTS = 1000

export interface ActivityState {
  /** Events ordered by seq, deduplicated. */
  events: ActivityEvent[]
  /** Older events not available: evicted from the API ring or the client cap. */
  truncated: number
  /** Gaps reported by the server that later events have not yet bracketed. */
  serverGaps: Array<{ fromSeq: number; toSeq: number }>
  finished: boolean
  /** Backlog received at least once (the stream is "live"). */
  loaded: boolean
  error: string | null
}

export const initialActivityState: ActivityState = {
  events: [],
  truncated: 0,
  serverGaps: [],
  finished: false,
  loaded: false,
  error: null,
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Validate one event from the wire; drops events without type/seq or of another task. */
export function toActivityEvent(v: unknown, taskId: string): ActivityEvent | null {
  if (!isObject(v)) return null
  if (typeof v.type !== 'string' || !v.type) return null
  if (typeof v.seq !== 'number' || !Number.isFinite(v.seq)) return null
  if (typeof v.taskId === 'string' && v.taskId && v.taskId !== taskId) return null
  return { ...(v as unknown as ActivityEvent), taskId }
}

/** Insert ev into the seq-ordered list, ignoring duplicates. */
function insertBySeq(events: ActivityEvent[], ev: ActivityEvent): ActivityEvent[] {
  const last = events[events.length - 1]
  if (!last || ev.seq > last.seq) return [...events, ev]
  if (events.some((e) => e.seq === ev.seq)) return events
  const i = events.findIndex((e) => e.seq > ev.seq)
  return [...events.slice(0, i), ev, ...events.slice(i)]
}

function capEvents(state: ActivityState): ActivityState {
  const over = state.events.length - MAX_CLIENT_EVENTS
  if (over <= 0) return state
  return { ...state, events: state.events.slice(over), truncated: state.truncated + over }
}

/** Apply one activity WS message for taskId. Messages for other tasks are ignored. */
export function applyActivityMessage(state: ActivityState, msg: unknown, taskId: string): ActivityState {
  if (!isObject(msg) || typeof msg.op !== 'string') return state
  if (msg.taskId !== taskId && !(msg.op === 'error' && !msg.taskId)) return state
  switch (msg.op) {
    case 'backlog': {
      // A (re-)subscribe starts over with the server's buffer.
      const list = Array.isArray(msg.events) ? msg.events : []
      let events: ActivityEvent[] = []
      for (const raw of list) {
        const ev = toActivityEvent(raw, taskId)
        if (ev) events = insertBySeq(events, ev)
      }
      const truncated = typeof msg.truncated === 'number' && msg.truncated > 0 ? msg.truncated : 0
      const finished = msg.finished === true || events.some((e) => e.type === 'task.finished')
      return capEvents({ events, truncated, serverGaps: [], finished, loaded: true, error: null })
    }
    case 'event': {
      const ev = toActivityEvent(msg.event, taskId)
      if (!ev) return state
      const events = insertBySeq(state.events, ev)
      if (events === state.events) return state
      return capEvents({
        ...state,
        events,
        finished: state.finished || ev.type === 'task.finished',
        // Once a later event arrives, the seq jump itself marks the gap.
        serverGaps: state.serverGaps.filter((g) => g.toSeq >= ev.seq),
      })
    }
    case 'gap': {
      const fromSeq = Number(msg.fromSeq)
      const toSeq = Number(msg.toSeq)
      if (!Number.isFinite(fromSeq) || !Number.isFinite(toSeq) || toSeq < fromSeq) return state
      return { ...state, serverGaps: [...state.serverGaps, { fromSeq, toSeq }] }
    }
    case 'error':
      return { ...state, error: typeof msg.error === 'string' && msg.error ? msg.error : 'activity stream error' }
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Timeline

export type TimelineItem =
  | { kind: 'truncated'; key: string; count: number }
  | { kind: 'gap'; key: string; fromSeq: number; toSeq: number }
  | { kind: 'started'; key: string; event: ActivityEvent }
  | { kind: 'message'; key: string; event: ActivityEvent }
  | {
      kind: 'tool'
      key: string
      tool: string
      toolCallId?: string
      started?: ActivityEvent
      finished?: ActivityEvent
    }
  | { kind: 'finished'; key: string; event: ActivityEvent }

/**
 * Build the timeline from seq-ordered events: assistant messages, tool calls
 * (tool.started + tool.finished paired by toolCallId), lifecycle markers, and
 * gap / truncation markers derived from seq. Heartbeats only feed the header.
 */
export function buildTimeline(state: ActivityState): TimelineItem[] {
  const items: TimelineItem[] = []
  const { events } = state
  const first = events[0]
  const missingAtStart = first ? first.seq - 1 : 0
  if (state.truncated > 0) {
    // Older events were evicted from the buffer (API ring or client cap).
    items.push({ kind: 'truncated', key: 'truncated', count: state.truncated })
  } else if (missingAtStart > 0) {
    // seq starts at 1: anything before the first event we have was lost.
    items.push({ kind: 'gap', key: 'gap-1', fromSeq: 1, toSeq: missingAtStart })
  }

  const openTools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>()
  let prevSeq: number | null = null
  for (const ev of events) {
    if (prevSeq != null && ev.seq > prevSeq + 1) {
      items.push({ kind: 'gap', key: `gap-${prevSeq + 1}`, fromSeq: prevSeq + 1, toSeq: ev.seq - 1 })
    }
    prevSeq = ev.seq
    const key = `seq-${ev.seq}`
    switch (ev.type) {
      case 'task.started':
        items.push({ kind: 'started', key, event: ev })
        break
      case 'assistant.message':
        items.push({ kind: 'message', key, event: ev })
        break
      case 'tool.started': {
        const item: Extract<TimelineItem, { kind: 'tool' }> = {
          kind: 'tool', key, tool: ev.tool || 'tool', toolCallId: ev.toolCallId, started: ev,
        }
        items.push(item)
        if (ev.toolCallId) openTools.set(ev.toolCallId, item)
        break
      }
      case 'tool.finished': {
        const open = ev.toolCallId ? openTools.get(ev.toolCallId) : undefined
        if (open && !open.finished) {
          open.finished = ev
          if (ev.toolCallId) openTools.delete(ev.toolCallId)
        } else {
          items.push({ kind: 'tool', key, tool: ev.tool || 'tool', toolCallId: ev.toolCallId, finished: ev })
        }
        break
      }
      case 'task.finished':
        items.push({ kind: 'finished', key, event: ev })
        break
      default:
        break // heartbeats and unknown types
    }
  }
  for (const g of state.serverGaps) {
    if (prevSeq == null || g.fromSeq > prevSeq) {
      items.push({ kind: 'gap', key: `sgap-${g.fromSeq}`, fromSeq: g.fromSeq, toSeq: g.toSeq })
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// Header

export interface ActivitySummary {
  knight?: string
  pod?: string
  node?: string
  runId?: string
  chainName?: string
  stepName?: string
  model?: string
  /** RFC 3339 time of task.started (or the first event seen). */
  startedAt?: string
  /** Wall time of task.finished, when seen. */
  finishedAt?: string
  durationMs?: number
  costUsd?: number
  turns?: number
  inputTokens?: number
  outputTokens?: number
  currentTool?: string
  success?: boolean
  errorClass?: string
}

/** Latest known header values (later events win). */
export function summarizeActivity(events: ActivityEvent[]): ActivitySummary {
  const s: ActivitySummary = {}
  for (const ev of events) {
    for (const k of ['knight', 'pod', 'node', 'runId', 'chainName', 'stepName', 'model'] as const) {
      if (typeof ev[k] === 'string' && ev[k]) s[k] = ev[k]
    }
    if (ev.type === 'task.started' && ev.ts) s.startedAt = ev.ts
    if (!s.startedAt && ev.ts) s.startedAt = ev.ts
    if (ev.type === 'task.heartbeat' || ev.type === 'task.finished') {
      if (typeof ev.costUsd === 'number') s.costUsd = ev.costUsd
      if (typeof ev.turns === 'number') s.turns = ev.turns
      if (typeof ev.inputTokens === 'number') s.inputTokens = ev.inputTokens
      if (typeof ev.outputTokens === 'number') s.outputTokens = ev.outputTokens
    }
    if (ev.type === 'task.heartbeat') s.currentTool = ev.currentTool || undefined
    if (ev.type === 'task.finished') {
      s.finishedAt = ev.ts
      s.currentTool = undefined
      if (typeof ev.durationMs === 'number') s.durationMs = ev.durationMs
      if (typeof ev.success === 'boolean') s.success = ev.success
      if (ev.errorClass) s.errorClass = ev.errorClass
    }
  }
  return s
}

/** Elapsed ms: task.finished duration when known, otherwise start → finish/now. */
export function elapsedMs(s: ActivitySummary, now: number): number | null {
  if (s.durationMs != null) return s.durationMs
  const start = s.startedAt ? Date.parse(s.startedAt) : NaN
  if (Number.isNaN(start)) return null
  const end = s.finishedAt ? Date.parse(s.finishedAt) : now
  return Math.max(0, (Number.isNaN(end) ? now : end) - start)
}

/** Compact duration: 850ms, 4.2s, 2m 5s, 1h 3m. */
export function formatMs(ms: number | null | undefined): string {
  return formatMsLadder(ms)
}
