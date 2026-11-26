import { formatCost, formatSecondsLadder } from './format'
/**
 * Schedules: Triggers with a spec.source.schedule, served by the gateway's
 * /v1/schedules routes and proxied by the dashboard API under /api/schedules
 * (roundtable-k8s/roundtable docs/gateway.md, "Schedules").
 */

/** Who owns a schedule. Git-managed schedules cannot be edited or deleted here. */
export type ManagedBy = 'git' | 'api' | 'other'

export interface ScheduleTarget {
  kind: 'chain' | 'knight' | 'mission' | string
  /** One-line description of the target. */
  summary: string
  chain?: string
  knight?: string
}

export interface ScheduleFiring {
  time: string
  outcome: string
  run?: string
  skipReason?: string
}

export interface Schedule {
  name: string
  namespace: string
  table?: string
  cron: string
  timeZone: string
  /** The cron in words. */
  description?: string
  target: ScheduleTarget
  suspended: boolean
  nextRunAt?: string
  lastRunAt?: string
  lastResult?: ScheduleFiring
  managedBy: ManagedBy
}

/** One firing of a schedule (GET …/runs), newest first. */
export interface ScheduleRun {
  run?: string
  time: string
  key?: string
  outcome: 'succeeded' | 'failed' | 'partiallySucceeded' | 'lost' | 'skipped' | 'pending' | 'running' | 'unknown' | string
  reason?: string
  durationSeconds?: number
  costUSD?: string
  resultAvailable: boolean
}

export interface ScheduleRunStep {
  name: string
  phase?: string
  error?: string
  output?: string
  outputTruncated?: boolean
}

/** A run's result (GET …/runs/{run}). */
export interface ScheduleRunResult {
  schedule: string
  target: string
  run: string
  chain?: string
  namespace?: string
  phase: string
  done?: boolean
  createdAt?: string
  startedAt?: string
  completedAt?: string
  steps?: ScheduleRunStep[]
  output?: string
  outputTruncated?: boolean
}

/** Answer of POST …/suspend and …/resume. */
export interface ScheduleSuspendState {
  name: string
  namespace: string
  suspended: boolean
  suspendedBy?: string
  message?: string
}

/** Answer of POST …/run. */
export interface ScheduleRunNow {
  schedule: string
  namespace: string
  run?: string
  target?: string
  state: 'started' | 'pending' | 'skipped' | string
  reason?: string
}

export const RUN_HISTORY_LIMIT = 50

/** Dashboard API path of a schedule, or of one of its sub-routes. */
export function scheduleApi(namespace: string, name: string, ...rest: string[]): string {
  return ['/api/schedules', namespace, name, ...rest].map((p, i) => (i === 0 ? p : encodeURIComponent(p))).join('/')
}

/** Dashboard route of a schedule's detail view. */
export function scheduleLink(namespace: string, name: string): string {
  return `/schedules/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
}

/** Runs newest first, whatever order the API returned them in. */
export function sortRunsNewestFirst(runs: ScheduleRun[]): ScheduleRun[] {
  return [...runs].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
}

/** 212.4 → "3m 32s"; undefined → "—". */
export function formatSeconds(sec?: number): string {
  return formatSecondsLadder(sec)
}

/** "0.41" → "$0.41"; missing or unparsable → "—". */
export function formatCostUSD(cost?: string): string {
  if (!cost) return '—'
  const n = Number(cost)
  if (!Number.isFinite(n)) return '—'
  return formatCost(n)
}

const OUTCOME_LABELS: Record<string, string> = {
  succeeded: 'Succeeded',
  failed: 'Failed',
  partiallySucceeded: 'Partially succeeded',
  lost: 'Lost',
  skipped: 'Skipped',
  pending: 'Pending',
  running: 'Running',
  started: 'Started',
  unknown: 'Unknown',
}

export function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome
}

export function outcomeClass(outcome: string): string {
  switch (outcome) {
    case 'succeeded': return 'border-green-500/30 bg-green-500/10 text-green-300'
    case 'failed':
    case 'lost': return 'border-red-500/30 bg-red-500/10 text-red-300'
    case 'partiallySucceeded':
    case 'skipped': return 'border-amber-500/30 bg-amber-500/10 text-amber-300'
    case 'running':
    case 'pending':
    case 'started': return 'border-blue-500/30 bg-blue-500/10 text-blue-300'
    default: return 'border-gray-500/30 bg-gray-500/10 text-gray-300'
  }
}

/**
 * The text a run produced: the final output when the gateway could pick one,
 * else every step's output (or error) under its name.
 */
export function runResultText(r: ScheduleRunResult): string {
  if (r.output) return r.output
  const parts = (r.steps ?? [])
    .filter((s) => s.output || s.error)
    .map((s) => `## ${s.name}\n\n${s.output ?? ''}${s.error ? `${s.output ? '\n\n' : ''}Error: ${s.error}` : ''}`)
  return parts.join('\n\n')
}

export interface ScheduleList {
  schedules: Schedule[]
}

export const SCHEDULE_DOCS_URL = 'https://github.com/roundtable-k8s/roundtable/blob/main/docs/gateway.md#schedules'

export function scheduleKey(s: { namespace: string; name: string }): string {
  return `${s.namespace}/${s.name}`
}

/** The dashboard route of the edit form (#302). Git-managed schedules have none. */
export function scheduleEditPath(s: { namespace: string; name: string }): string {
  return `/schedules/${encodeURIComponent(s.namespace)}/${encodeURIComponent(s.name)}/edit`
}

/** The first non-empty line of a task. */
export function firstLine(text?: string): string {
  if (!text) return ''
  return text.split('\n').map((l) => l.trim()).find((l) => l) ?? ''
}

/** The knight or chain a schedule targets. */
export function targetName(t: ScheduleTarget): string {
  return t.knight || t.chain || t.summary
}
