import { useMemo } from 'react'
import { usePolledFetch } from './usePolledFetch'

export interface Health {
  status?: string
  kubernetes?: string
  nats?: string
  /** The last poll failed: the fields above are the last known state and may be stale. */
  error?: boolean
}

/**
 * /api/health at load and every minute, shared by every component using it. A failed request keeps
 * the last known state but sets `error` (a later success replaces the state and clears it).
 * With no answer yet, the result is null.
 */
export function useHealth(intervalMs = 60000): Health | null {
  const { data, error } = usePolledFetch<Health | null>('/api/health', intervalMs, null)
  return useMemo(() => (error ? (data ? { ...data, error: true } : null) : data ?? null), [data, error])
}
