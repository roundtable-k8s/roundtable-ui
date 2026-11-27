import { useState } from 'react'
import { useVisibleInterval } from './useVisibleInterval'
import { apiGet } from '../lib/api'

export interface Health {
  status?: string
  kubernetes?: string
  nats?: string
  /** The last poll failed: the fields above are the last known state and may be stale. */
  error?: boolean
}

/**
 * /api/health at load and every minute. A failed request keeps the last known state but sets `error`
 * (a later success replaces the state and clears it). With no answer yet, the result is null.
 */
export function useHealth(intervalMs = 60000): Health | null {
  const [health, setHealth] = useState<Health | null>(null)
  useVisibleInterval(
    (signal) =>
      apiGet<Health>('/api/health', { signal })
        .then((h) => setHealth(h ?? null))
        .catch(() => { if (!signal.aborted) setHealth((prev) => (prev ? { ...prev, error: true } : null)) }),
    intervalMs,
    true,
    { immediate: true },
  )
  return health
}
