// Per-pod log helpers for the knight drawer (#218, part of #186).

export interface PodContainer {
  name: string
  ready: boolean
  restartCount: number
  hasPrevious: boolean
}

export interface KnightPod {
  name: string
  phase: string
  ready: boolean
  node?: string
  startTime?: string
  restarts: number
  containers: PodContainer[]
  lastActivity?: string
}

export interface KnightPodsResponse {
  pods: KnightPod[]
  default?: string
}

export interface PodLogsQuery {
  pod?: string
  container?: string
  previous?: boolean
  timestamps?: boolean
}

/** Builds GET /api/fleet/{knight}/logs with the optional per-pod params. */
export function podLogsUrl(knight: string, q: PodLogsQuery = {}): string {
  const params = new URLSearchParams()
  if (q.pod) params.set('pod', q.pod)
  if (q.container) params.set('container', q.container)
  if (q.previous) params.set('previous', 'true')
  if (q.timestamps) params.set('timestamps', 'true')
  const qs = params.toString()
  return `/api/fleet/${encodeURIComponent(knight)}/logs${qs ? `?${qs}` : ''}`
}

/** Short label for a pod: the part after "<knight>-", else the full name. */
export function shortPodName(pod: string, knight: string): string {
  const prefix = `${knight.toLowerCase()}-`
  return pod.startsWith(prefix) && pod.length > prefix.length ? pod.slice(prefix.length) : pod
}

/** Text colours for per-pod prefixes in the merged view (cycled by index). */
export const POD_COLORS = [
  'text-sky-400',
  'text-emerald-400',
  'text-amber-400',
  'text-fuchsia-400',
  'text-rose-400',
  'text-lime-400',
  'text-cyan-400',
  'text-orange-400',
]

export function podColor(index: number): string {
  return POD_COLORS[((index % POD_COLORS.length) + POD_COLORS.length) % POD_COLORS.length]
}

export interface MergedLogLine {
  pod: string
  /** Epoch ms of the line's timestamp, or null when the line has none. */
  ts: number | null
  text: string
}

// Kubernetes timestamps=true prefix: RFC3339(Nano) then one space.
const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) (.*)$/

/** Splits a timestamps=true log line into its time and text. */
export function parseTimestampedLine(line: string): { ts: number | null; text: string } {
  const m = TS_RE.exec(line)
  if (!m) return { ts: null, text: line }
  const ts = Date.parse(m[1])
  return Number.isNaN(ts) ? { ts: null, text: line } : { ts, text: m[2] }
}

/**
 * Merges several pods' timestamps=true log tails into one stream ordered by
 * time. Lines without a timestamp keep the time of the previous line of the
 * same pod so multi-line entries stay together; ties keep input order.
 */
export function mergePodLogs(streams: { pod: string; text: string }[]): MergedLogLine[] {
  const lines: (MergedLogLine & { order: number; key: number })[] = []
  let order = 0
  for (const s of streams) {
    let last = -Infinity
    for (const raw of s.text.split('\n')) {
      if (raw === '') continue
      const { ts, text } = parseTimestampedLine(raw)
      if (ts != null) last = ts
      lines.push({ pod: s.pod, ts, text, order: order++, key: ts ?? last })
    }
  }
  lines.sort((a, b) => (a.key === b.key ? a.order - b.order : a.key - b.key))
  return lines.map(({ pod, ts, text }) => ({ pod, ts, text }))
}
