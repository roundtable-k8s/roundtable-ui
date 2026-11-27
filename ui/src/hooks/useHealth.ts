import { useState } from 'react'
import { useVisibleInterval } from './useVisibleInterval'
import { apiGet } from '../lib/api'

export interface Health {
  status?: string
  kubernetes?: string
  nats?: string
}

/** /api/health at load and every minute. A failed request keeps the last known state (no warning). */
export function useHealth(intervalMs = 60000): Health | null {
  const [health, setHealth] = useState<Health | null>(null)
  useVisibleInterval(
    (signal) =>
      apiGet<Health>('/api/health', { signal })
        .then((h) => setHealth(h ?? null))
        .catch(() => {}),
    intervalMs,
    true,
    { immediate: true },
  )
  return health
}
