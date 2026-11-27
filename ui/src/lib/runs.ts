// Gateway chain runs of every source (#537). Pure, no React.

export const RUN_SOURCES = ['gateway', 'trigger', 'pickup'] as const
export const RUN_PHASES = ['Pending', 'Running', 'Succeeded', 'Failed'] as const

export interface RunIssue { repo: string; number: number }

export interface GatewayRun {
  run: string
  chain?: string
  namespace?: string
  phase?: string
  source?: string
  ageSeconds?: number
  runningSeconds?: number
  traceId?: string
  caller?: string
  issue?: RunIssue
}

/** Accepts `{runs: [...]}` (or a bare array); anything else yields no rows. */
export function runRows(data: unknown): GatewayRun[] {
  const list = Array.isArray(data) ? data : (data as { runs?: unknown } | null)?.runs
  if (!Array.isArray(list)) return []
  return list.filter((r): r is GatewayRun => !!r && typeof r === 'object' && typeof (r as GatewayRun).run === 'string')
}

/** Seconds → "45s" / "12m" / "5h 12m" / "44d 3h"; "—" when missing or invalid. */
export function ageLabel(seconds: number | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return '—'
  const sec = Math.max(0, Math.floor(seconds))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ${min % 60}m`
  return `${Math.floor(hr / 24)}d ${hr % 24}h`
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** GitHub issue URL; '' unless repo is owner/name and number a positive integer. */
export function issueUrl(issue: RunIssue | undefined): string {
  if (!issue || typeof issue.repo !== 'string' || !REPO_RE.test(issue.repo)) return ''
  if (!Number.isInteger(issue.number) || issue.number <= 0) return ''
  if (issue.repo.split('/').some((p) => p === '.' || p === '..')) return ''
  return `https://github.com/${issue.repo}/issues/${issue.number}`
}

/** Request URL for the polled list. */
export function runsUrl(source: string, active: boolean): string {
  const q = new URLSearchParams({ source, limit: '100' })
  if (active) q.set('active', 'true')
  return `/api/gateway/runs?${q.toString()}`
}
