// Session history grouping and pod-gone handling for the Sessions page (#220).
//
// A knight with N replicas keeps each session on the pod that ran it, so the
// page shows past sessions grouped by run, then pod, then session. Every sort
// here is total (ties broken by name/id) so a refresh never reorders the list
// or moves a session to another pod.
import type { SessionHistoryItem } from '../hooks/useKnightSession'
import { ApiError } from './api'

export interface PodSessionGroup {
  pod: string | null      // null: the API did not report a pod (older runtime)
  sessions: SessionHistoryItem[]
}

export interface RunSessionGroup {
  runId: string | null    // null: sessions not tied to a run
  pods: PodSessionGroup[]
}

function startedMs(s: SessionHistoryItem): number {
  const t = s.startedAt ? Date.parse(s.startedAt) : NaN
  return Number.isNaN(t) ? -Infinity : t
}

// Newest first, then by id so equal timestamps keep a fixed order.
function compareSessions(a: SessionHistoryItem, b: SessionHistoryItem): number {
  const d = startedMs(b) - startedMs(a)
  if (d !== 0 && !Number.isNaN(d)) return d
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// Named entries sorted by name; the unnamed (null) bucket last.
function compareNames(a: string | null, b: string | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return a < b ? -1 : 1
}

/**
 * Groups past sessions by run → pod → session.
 * Runs: newest session first (ties by runId), sessions without a run last.
 * Pods: by name. Sessions: newest first (ties by id).
 */
export function groupSessions(items: SessionHistoryItem[]): RunSessionGroup[] {
  const runs = new Map<string | null, Map<string | null, SessionHistoryItem[]>>()
  for (const s of items) {
    const runId = s.runId || null
    const pod = s.pod || null
    let pods = runs.get(runId)
    if (!pods) runs.set(runId, (pods = new Map()))
    let list = pods.get(pod)
    if (!list) pods.set(pod, (list = []))
    list.push(s)
  }

  const groups: (RunSessionGroup & { newest: number })[] = []
  for (const [runId, pods] of runs) {
    let newest = -Infinity
    const podGroups: PodSessionGroup[] = []
    for (const [pod, sessions] of pods) {
      sessions.sort(compareSessions)
      newest = Math.max(newest, startedMs(sessions[0]))
      podGroups.push({ pod, sessions })
    }
    podGroups.sort((a, b) => compareNames(a.pod, b.pod))
    groups.push({ runId, pods: podGroups, newest })
  }
  groups.sort((a, b) => {
    if ((a.runId === null) !== (b.runId === null)) return a.runId === null ? 1 : -1
    if (a.newest !== b.newest) return b.newest - a.newest
    return compareNames(a.runId, b.runId)
  })
  return groups.map(({ runId, pods }) => ({ runId, pods }))
}

// Label for one run+pod bucket in the session picker.
export function groupLabel(runId: string | null, pod: string | null): string {
  const run = runId ? `Run ${runId}` : 'No run'
  return pod ? `${run} · pod ${pod}` : run
}

/**
 * The API answers 410 with {"podGone": true, "pod": ...} when a session's
 * pod has been scaled away or is no longer ready (#220). Returns the pod name
 * only for that body: a 410 from anything else (e.g. a proxy) is a plain error.
 */
export async function podGoneFrom(res: Response | null, fallbackPod: string | null): Promise<string | null> {
  if (!res || res.status !== 410) return null
  try {
    const body = await res.json()
    if (body && body.podGone === true) {
      return typeof body.pod === 'string' && body.pod ? body.pod : fallbackPod || 'unknown'
    }
  } catch {
    // not the API's pod-gone body
  }
  return null
}

// Pod and run named by a "/sessions?knight=&pod=&runId=" deep link, if valid.
const POD_RE = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function parseSessionTarget(params: URLSearchParams): { pod: string | null; runId: string | null } {
  const pod = params.get('pod') || ''
  const runId = params.get('runId') || ''
  return {
    pod: POD_RE.test(pod) ? pod : null,
    runId: RUN_RE.test(runId) ? runId : null,
  }
}

// Link to a knight's sessions focused on one pod and run.
export function sessionsLink(knight: string, pod?: string | null, runId?: string | null): string {
  const q = new URLSearchParams({ knight: knight.toLowerCase() })
  if (pod) q.set('pod', pod)
  if (runId) q.set('runId', runId)
  return `/sessions?${q.toString()}`
}

/**
 * Picks the past session a deep link points at: the newest session of the
 * run on that pod, else the newest session on that pod. Null when the pod
 * has no listed session (the caller then checks whether the pod is gone).
 */
export function pickTargetSession(items: SessionHistoryItem[], pod: string | null, runId: string | null): SessionHistoryItem | null {
  if (!pod && !runId) return null
  const match = (s: SessionHistoryItem, withRun: boolean) =>
    (!pod || s.pod === pod) && (!withRun || s.runId === runId)
  const sorted = [...items].sort(compareSessions)
  if (runId) {
    const hit = sorted.find(s => match(s, true))
    if (hit) return hit
  }
  return pod ? sorted.find(s => match(s, false)) ?? null : null
}

export type IntrospectErrorKind = 'unsupported' | 'timeout' | 'unavailable' | 'failed'

/** True for a caller-cancelled request (knight change, unmount): ignore it, do not report it. */
export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError'
}

/**
 * Sorts a failed introspect call: 'unsupported' (404 — the route/knight has no
 * introspection), 'timeout' (504 or the client's own timeout), 'unavailable'
 * (429, 502, 503: rate limit or infrastructure) or 'failed' (anything else).
 * An offline knight answers 200 `{}`, which is not an error.
 */
export function classifyIntrospectError(e: unknown): IntrospectErrorKind {
  if (e instanceof ApiError) {
    if (e.status === 404) return 'unsupported'
    if (e.status === 504 || e.status === 0) return 'timeout'
    if (e.status === 429 || e.status === 502 || e.status === 503) return 'unavailable'
  }
  return 'failed'
}

export function introspectErrorMessage(kind: IntrospectErrorKind): string {
  switch (kind) {
    case 'timeout': return 'The knight did not answer in time. Try again shortly.'
    case 'unavailable': return 'Session data is temporarily unavailable. Try again shortly.'
    case 'unsupported': return 'This knight does not support session introspection.'
    default: return 'Failed to load session data.'
  }
}
