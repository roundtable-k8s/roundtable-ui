/** Chat with a knight through the gateway proxy (/api/chat). */

export type { GatewayUsage as ChatUsage, GatewayTask as ChatTask } from './gatewayTask'
import type { GatewayUsage as ChatUsage, GatewayTask as ChatTask } from './gatewayTask'

export interface ChatTurn extends ChatUsage {
  id: number
  message: string
  taskId?: string
  status: string
  output?: string
  error?: string
  model?: string
  traceId?: string
}

export { isFinalStatus } from './gatewayTask'

export interface ChatKnight {
  name: string
  namespace?: string
  domain?: string
  model?: string
  runtime?: string
  roundTable?: string
  phase?: string
  ready?: boolean
  suspended?: boolean
  /** Only with `GET /api/chat/knights?load=true`; absent when the gateway could not read NATS. */
  queue?: { pending: number; inFlight: number }
}

/** Select-option key: `namespace/name` when the knight has a namespace. */
export const knightKey = (k: ChatKnight) => (k.namespace ? `${k.namespace}/${k.name}` : k.name)

/** GET /api/chat/knights answers {knights:[...]} or a bare array of names / objects. */
export function parseKnights(data: unknown): ChatKnight[] {
  const list = Array.isArray(data) ? data : (data as { knights?: unknown })?.knights
  if (!Array.isArray(list)) return []
  const out = new Map<string, ChatKnight>()
  for (const k of list) {
    const name = typeof k === 'string' ? k : (k as { name?: unknown })?.name
    if (typeof name !== 'string' || name === '') continue
    const ns = typeof k === 'string' ? undefined : (k as { namespace?: unknown }).namespace
    const entry: ChatKnight = typeof ns === 'string' && ns !== '' ? { name, namespace: ns } : { name }
    out.set(knightKey(entry), entry)
  }
  return Array.from(out.values()).sort((a, b) => knightKey(a).localeCompare(knightKey(b)))
}

function isTokens(v: unknown): v is { input: number; output: number } {
  return typeof v === 'object' && v !== null
    && typeof (v as { input?: unknown }).input === 'number'
    && typeof (v as { output?: unknown }).output === 'number'
}

export function mergeTurn(turn: ChatTurn, t: ChatTask): ChatTurn {
  return {
    ...turn,
    taskId: t.taskId || turn.taskId,
    status: t.status ?? turn.status,
    output: t.output ?? turn.output,
    error: t.error ?? turn.error,
    model: t.model ?? turn.model,
    cost: typeof t.cost === 'number' ? t.cost : turn.cost,
    billing: typeof t.billing === 'string' && t.billing !== '' ? t.billing : turn.billing,
    durationMs: typeof t.durationMs === 'number' ? t.durationMs : turn.durationMs,
    tokens: isTokens(t.tokens) ? t.tokens : turn.tokens,
    turns: typeof t.turns === 'number' ? t.turns : turn.turns,
    toolCalls: typeof t.toolCalls === 'number' ? t.toolCalls : turn.toolCalls,
    usageLimited: typeof t.usageLimited === 'boolean' ? t.usageLimited : turn.usageLimited,
    traceId: t.traceId || turn.traceId,
  }
}
