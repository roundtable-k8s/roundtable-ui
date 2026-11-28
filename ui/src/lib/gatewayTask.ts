/** Shared shapes of the gateway's task record (POST /v1/knights/{name}/invoke, GET /v1/tasks/{id}). */

/** A pull request the task opened or touched (gateway PRRef). */
export interface PullRequestRef {
  repo?: string
  number?: number
  url?: string
  action?: string
}

/** Usage a gateway task record carries; each field is absent when the gateway did not report it. */
export interface GatewayUsage {
  /** USD; notional (API-equivalent) when billing is "subscription". */
  cost?: number
  billing?: string
  durationMs?: number
  tokens?: { input?: number; output?: number }
  turns?: number
  toolCalls?: number
  usageLimited?: boolean
  model?: string
  requestedModel?: string
  prs?: PullRequestRef[]
  verdict?: string
}

/** Task record returned by the gateway. */
export interface GatewayTask extends GatewayUsage {
  taskId: string
  runId?: string
  roundTable?: string
  status?: string
  output?: string
  error?: string
  /** Trace ID of the gateway's server span; the UI links it when a trace URL is configured. */
  traceId?: string
}

export const isFinalStatus = (status: string | undefined) =>
  status === 'succeeded' || status === 'failed'
