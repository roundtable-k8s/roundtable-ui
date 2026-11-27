/**
 * Schedules: Triggers with a spec.source.schedule, served by the gateway's
 * /v1/schedules routes and proxied by the dashboard API under /api/schedules
 * (roundtable-k8s/roundtable docs/gateway.md, "Schedules").
 */
import { formatCost, formatSecondsLadder } from './format'

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

/** The concurrency policy of a schedule: Allow, Forbid or Replace, with an optional cap on active runs. */
export interface ScheduleConcurrency {
  policy: string
  maxActive?: number
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
  concurrency?: ScheduleConcurrency
  /** Seconds after a missed fire time during which it may still start; unset means none. */
  startingDeadlineSeconds?: number
  /** What suspends the schedule: "spec", "annotation" or both, comma-separated ("spec,annotation"). */
  suspendedBy?: string
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
  /** 32-hex trace ID of the run, when the gateway knows it. */
  traceId?: string
  /** Knight targets only. */
  turns?: number
  /** Knight targets only; absent means unknown, not 0. */
  toolCalls?: number
}

export interface ScheduleRunStep {
  name: string
  phase?: string
  error?: string
  output?: string
  outputTruncated?: boolean
}

/** A pull request a task opened or updated (gateway PRRef). */
export interface ScheduleRunPR {
  repo?: string
  number?: number
  url?: string
  action?: string
}

/** The task a knight-target run created. */
export interface ScheduleRunTask {
  run?: string
  knight?: string
  status?: string
  output?: string
  error?: string
  model?: string
  verdict?: string
  prs?: ScheduleRunPR[]
  traceId?: string
  createdAt?: string
  completedAt?: string
}

/** The mission a mission-target run created. */
export interface ScheduleRunMission {
  name?: string
  namespace?: string
  phase?: string
  done?: boolean
  result?: string
  traceId?: string
  totalCost?: string
}

/** A run's result (GET …/runs/{run}). */
export interface ScheduleRunResult {
  schedule: string
  target: string
  run: string
  chain?: string
  namespace?: string
  phase?: string
  task?: ScheduleRunTask
  mission?: ScheduleRunMission
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
  skipReason?: string
}

export const RUN_HISTORY_LIMIT = 50

/** The Schedules page state filter (?state=). */
export const SCHEDULE_STATES = ['all', 'active', 'suspended', 'failing'] as const
export type ScheduleState = (typeof SCHEDULE_STATES)[number]

/** Outcomes of the last firing that count as failing. */
const FAILING_OUTCOMES = ['failed', 'lost']

/** Whether a schedule's last firing failed or was lost. No lastResult is not failing. */
export function isFailing(s: Schedule): boolean {
  return !!s.lastResult && FAILING_OUTCOMES.includes(s.lastResult.outcome)
}

/** Narrows schedules to one state: all, active (not suspended), suspended, or failing (last firing failed or lost). */
export function filterSchedules(list: Schedule[], state: ScheduleState | string): Schedule[] {
  switch (state) {
    case 'active': return list.filter((s) => !s.suspended)
    case 'suspended': return list.filter((s) => s.suspended)
    case 'failing': return list.filter(isFailing)
    default: return list
  }
}

/** Dashboard API path of a schedule, or of one of its sub-routes. */
export function scheduleApi(namespace: string, name: string, ...rest: string[]): string {
  return ['/api/schedules', namespace, name, ...rest].map((p, i) => (i === 0 ? p : encodeURIComponent(p))).join('/')
}

/** One cron tick answered by the gateway: UTC and in the schedule's zone. */
export interface ScheduleNextTime {
  time: string
  local: string
}

/** The gateway's next fire times (preview and /next). Cron ticks only: skip rules are not applied. */
export interface ScheduleNextRuns {
  times: ScheduleNextTime[]
  timeZone?: string
  suspended?: boolean
}

/** URL of the gateway's cron preview for an expression and zone. */
export function schedulePreviewUrl(cron: string, timeZone: string, count = 5): string {
  const q = new URLSearchParams({ cron, timeZone: timeZone || 'UTC', count: String(count) })
  return `/api/schedules/preview?${q.toString()}`
}

/** URL of a saved schedule's next fire times. */
export function scheduleNextUrl(namespace: string, name: string, count = 5): string {
  return `${scheduleApi(namespace, name, 'next')}?count=${count}`
}

/** Dashboard route of a schedule's detail view. */
export function scheduleLink(namespace: string, name: string): string {
  return `/schedules/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`
}

/** Runs newest first, whatever order the API returned them in. */
export function sortRunsNewestFirst(runs: ScheduleRun[]): ScheduleRun[] {
  return [...runs].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
}

/** "Forbid", or "Allow, up to 3 active" when a cap is set; "" when the gateway sent no policy. */
export function describePolicy(s: Pick<Schedule, 'concurrency'>): string {
  const c = s.concurrency
  if (!c?.policy) return ''
  return c.maxActive && c.maxActive > 0 ? `${c.policy}, up to ${c.maxActive} active` : c.policy
}

/** "annotation", or "spec and annotation" for "spec,annotation"; "" when nothing suspends it. */
export function describeSuspension(s: Pick<Schedule, 'suspendedBy'>): string {
  const parts = (s.suspendedBy ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "5m 0s" for a starting deadline; "none" when unset. */
export function describeDeadline(s: Pick<Schedule, 'startingDeadlineSeconds'>): string {
  return s.startingDeadlineSeconds == null ? 'none' : formatSecondsLadder(s.startingDeadlineSeconds)
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

/** Maps a Trigger run phase (PartiallySucceeded) to an outcome key (partiallySucceeded). */
export function phaseToOutcome(phase: string): string {
  return phase ? phase.charAt(0).toLowerCase() + phase.slice(1) : 'unknown'
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
  if (r.target === 'knight' || (!r.target && r.task)) return r.task?.output || r.task?.error || ''
  if (r.target === 'mission' || (!r.target && r.mission)) return r.mission?.result || ''
  const parts = (r.steps ?? [])
    .filter((s) => s.output || s.error)
    .map((s) => `## ${s.name}\n\n${s.output ?? ''}${s.error ? `${s.output ? '\n\n' : ''}Error: ${s.error}` : ''}`)
  return parts.join('\n\n')
}

/** "repo#12", or "repo" / "#12" / "" for whatever the PR reference carries. */
export function prLabel(pr: ScheduleRunPR): string {
  return `${pr.repo ?? ''}${pr.number != null ? `#${pr.number}` : ''}`
}

/** Outcome of a run result: the phase, else the knight task status or mission phase. */
export function runResultOutcome(r: ScheduleRunResult): string {
  return phaseToOutcome(r.phase || r.task?.status || r.mission?.phase || '')
}

/** "3 turns · 12 tool calls"; tool calls are left out when unreported; "" when nothing is reported. */
export function describeTurns(r: Pick<ScheduleRun, 'turns' | 'toolCalls'>): string {
  const parts: string[] = []
  if (r.turns != null) parts.push(`${r.turns} ${r.turns === 1 ? 'turn' : 'turns'}`)
  if (r.toolCalls != null) parts.push(`${r.toolCalls} ${r.toolCalls === 1 ? 'tool call' : 'tool calls'}`)
  return parts.join(' · ')
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
