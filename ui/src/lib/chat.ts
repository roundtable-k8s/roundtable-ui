/** Chat with a knight through the gateway proxy (/api/chat). */

/** Task record from the gateway; cost and tool calls appear when it carries them. */
export interface ChatTask {
  taskId: string
  runId?: string
  status?: string
  output?: string
  error?: string
  model?: string
  costUsd?: number
  toolCalls?: number
}

export interface ChatTurn {
  id: number
  message: string
  taskId?: string
  status: string
  output?: string
  error?: string
  model?: string
  costUsd?: number
  toolCalls?: number
}

export const isFinalStatus = (status: string | undefined) =>
  status === 'succeeded' || status === 'failed'

export interface ChatKnight {
  name: string
  namespace?: string
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

export function mergeTurn(turn: ChatTurn, t: ChatTask): ChatTurn {
  return {
    ...turn,
    taskId: t.taskId || turn.taskId,
    status: t.status ?? turn.status,
    output: t.output ?? turn.output,
    error: t.error ?? turn.error,
    model: t.model ?? turn.model,
    costUsd: typeof t.costUsd === 'number' ? t.costUsd : turn.costUsd,
    toolCalls: typeof t.toolCalls === 'number' ? t.toolCalls : turn.toolCalls,
  }
}
