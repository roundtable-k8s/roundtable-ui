/** Shared formatting helpers — the single source for money/time rendering. */

/** Dollar amounts: 4 decimals under a cent so small LLM costs stay visible. */
export function formatCost(cost: number): string {
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`
}

/**
 * The one elapsed-time ladder: "42s" / "3m 5s" / "2h 5m".
 * Seconds are rounded to the nearest whole second; negative or non-finite
 * input gives "—". Callers that want a clamp or a different rounding
 * pre-process the value (see formatAge, formatWait).
 */
export function formatSecondsLadder(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const s = Math.round(sec)
  if (s < 0) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** The ladder for milliseconds, with sub-minute detail: 850ms, 4.2s, 2m 5s, 1h 3m. */
export function formatMsLadder(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return formatSecondsLadder(Math.floor(ms / 1000))
}

/** Elapsed time between two ISO timestamps (end defaults to now). */
export function formatDuration(start: string | null, end: string | null): string {
  if (!start) return '—'
  const s = new Date(start).getTime()
  const e = end ? new Date(end).getTime() : Date.now()
  return formatSecondsLadder((e - s) / 1000)
}

/** "42s ago" / "3m ago" / "5h ago" / "2d ago" */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

/** Uptime seconds → "3h 12m" / "45m" */
export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

/** ISO timestamp → local date and time; unparsable input is returned as-is. */
export function formatDateTime(ts: string): string {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString()
}

/** ISO timestamp → local time of day */
export function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ts
  }
}

/** Time of day for today's events, date and time for older ones. */
export function formatTimestampOrDate(ts: string, now: number = Date.now()): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ts
  return d.toDateString() === new Date(now).toDateString() ? d.toLocaleTimeString() : d.toLocaleString()
}

/** Future timestamps (next scheduled run) as "in 5m". */
export function until(iso?: string): string {
  if (!iso) return '—'
  const sec = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  if (sec <= 0) return 'due now'
  if (sec < 60) return `in ${sec}s`
  if (sec < 3600) return `in ${Math.floor(sec / 60)}m`
  if (sec < 86400) return `in ${Math.floor(sec / 3600)}h`
  return `in ${Math.floor(sec / 86400)}d`
}
