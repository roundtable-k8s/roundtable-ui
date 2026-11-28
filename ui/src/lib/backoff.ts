/** Poll back-off shared by useVisibleInterval and the polled store (#628). */

function field(e: unknown, key: string): unknown {
  return e && typeof e === 'object' ? (e as Record<string, unknown>)[key] : undefined
}

/** The Retry-After wait (ms) an error carries, 0 when none. */
export function retryAfterOf(e: unknown): number {
  const r = field(e, 'retryAfterMs')
  return typeof r === 'number' && r > 0 ? r : 0
}

/** Failures worth slowing down for: 429, 5xx, timeouts/network (status 0) or an explicit Retry-After. */
export function shouldBackOff(e: unknown): boolean {
  if (retryAfterOf(e) > 0) return true
  const s = field(e, 'status')
  return typeof s === 'number' && (s >= 500 || s === 429 || s === 0)
}

/**
 * The wait before the next poll after `failures` consecutive failures: the interval doubled per
 * failure, capped at 5 x the interval or 60 s (the lower), and at least `retryAfterMs`.
 * 0 failures with no Retry-After is the plain interval.
 */
export function nextDelay(baseMs: number, failures: number, retryAfterMs = 0): number {
  const cap = Math.min(5 * baseMs, 60_000)
  const backoff = failures > 0 ? Math.min(baseMs * 2 ** failures, Math.max(cap, baseMs)) : baseMs
  return Math.max(backoff, retryAfterMs)
}

/** ms +-10 %, to spread timers that start together. */
export function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2))
}
