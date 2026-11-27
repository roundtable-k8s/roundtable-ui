/** Dead letters (failed and lost tasks) as the gateway returns them via /api/dead-letters. */

export type DeadLetterState = 'open' | 'retried' | 'resolved'

export interface DeadLetter {
  taskId: string
  table?: string
  knight: string
  state: DeadLetterState
  reason: string
  error?: string
  attempt: number
  retryOf?: string
  chainName?: string
  stepName?: string
  runId?: string
  deadLetteredAt?: string
  updatedAt: string
  retriedAs?: string
  /** 32-hex trace ID of the failed attempt, when the gateway knows it. */
  traceId?: string
  task?: { task?: string }
}

export interface RetryResult {
  taskId: string
  retryOf: string
  attempt: number
  knight: string
}

export const DEAD_LETTERS_URL = '/api/dead-letters'

export function deadLetterUrl(d: Pick<DeadLetter, 'taskId' | 'table'>): string {
  const q = d.table ? `?table=${encodeURIComponent(d.table)}` : ''
  return `${DEAD_LETTERS_URL}/${encodeURIComponent(d.taskId)}${q}`
}

/** Entry time: when it was dead-lettered, else its last update. */
export function deadLetterTime(d: DeadLetter): string {
  return d.deadLetteredAt ?? d.updatedAt
}

export function isChainOwned(d: DeadLetter): boolean {
  return !!d.chainName
}

/** First line of an error, cut to max chars. */
export function errorExcerpt(error: string | undefined, max = 80): string {
  const line = (error ?? '').trim().split('\n')[0]
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}
