// Shared NATS event parsing.
//
// Subject formats (pi-knight + dashboard API conventions):
//   tasks:    <fleet>.tasks.<domain>.<taskId>
//   results:  <fleet>.results.<taskId>          — no domain segment!
//
// Result payloads (pi-knight publishResult) carry the knight name directly
// (capitalized CR name, e.g. "Galahad") plus success/result/cost/tokens/
// duration_ms/model. There is no `domain` or `error` field — failure text
// lives in `result` when success === false.
import { knightNameForDomain } from './knights'
import type { NatsEvent } from '../hooks/useWebSocket'

export interface ResultData {
  task_id?: string
  knight?: string
  success?: boolean
  result?: string
  duration_ms?: number
  cost?: number
  tokens?: { input?: number; output?: number; total?: number }
  model?: string
  timestamp?: string
}

/** Parse event payload, which may arrive as a JSON string or an object. */
export function parseEventData(data: unknown): Record<string, unknown> {
  let v: unknown = data
  if (typeof data === 'string') {
    try { v = JSON.parse(data) } catch { return { raw: data } }
    // A string that parses to a non-object ("null", "12", '"x"') is not a payload.
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return { raw: data }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

/** Stable identity of an event (subject + timestamp), same as the feed's dedup key. */
function identity(e: NatsEvent): string {
  return `${e.subject}:${e.timestamp}`
}

/**
 * React keys for a list: the given base keys, suffixed with the occurrence
 * number when two entries share one, so a key follows its item when new
 * entries are prepended.
 */
export function uniqueKeys(bases: string[]): string[] {
  const seen = new Map<string, number>()
  return bases.map((b) => {
    const n = seen.get(b) ?? 0
    seen.set(b, n + 1)
    return n === 0 ? b : `${b}#${n}`
  })
}

/** Stable, unique React keys for a list of events. */
export function eventListKeys(events: NatsEvent[]): string[] {
  return uniqueKeys(events.map(identity))
}

/** Render any payload field as bounded text: strings as-is, others as JSON. */
export function displayText(v: unknown, max = 300): string {
  if (v === undefined || v === null) return ''
  let text: string
  if (typeof v === 'string') text = v
  else {
    try { text = JSON.stringify(v) ?? String(v) } catch { text = String(v) }
  }
  return text.length > max ? text.slice(0, max) + '…' : text
}

export interface ParsedEvent {
  /** Lowercase knight CR name (matches fleet/KNIGHT_CONFIG keys), if resolvable */
  knight: string | null
  /** Task domain — only present on task events (results carry no domain) */
  domain: string | null
  taskId: string
  data: Record<string, unknown>
}

/**
 * Resolve knight/domain/taskId for an event, honoring the per-type subject format.
 * Task events resolve their domain through `domains` (see domainIndex) when given,
 * else through the built-in table; a domain shared by several knights gives null.
 */
export function parseEvent(event: NatsEvent, domains?: ReadonlyMap<string, string>): ParsedEvent {
  const parts = event.subject.split('.')
  const data = parseEventData(event.data)

  if (event.type === 'result') {
    const payloadKnight = typeof data.knight === 'string' && data.knight ? data.knight.toLowerCase() : null
    return {
      knight: payloadKnight,
      domain: null,
      taskId: (typeof data.task_id === 'string' && data.task_id) || parts[2] || '',
      data,
    }
  }

  if (event.type === 'task') {
    const domain = parts[2] || null
    return {
      knight: !domain ? null : domains ? (domains.get(domain) ?? null) : knightNameForDomain(domain),
      domain,
      taskId: parts[3] || '',
      data,
    }
  }

  // mission/chain events: subject is <fleet>.<type>.<name...>
  return { knight: null, domain: null, taskId: '', data }
}

/** Failure reason for a failed result event, or null if it succeeded. */
export function resultFailureReason(data: Record<string, unknown>): string | null {
  if (data.success !== false) return null
  const text = typeof data.result === 'string' ? data.result.trim() : ''
  if (!text) return 'unknown error'
  return text.length > 160 ? text.slice(0, 160) + '…' : text
}
