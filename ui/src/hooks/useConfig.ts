import { useEffect, useState } from 'react'
import { apiGet } from '../lib/api'

export interface AppConfig {
  fleetPrefix?: string
  /** Trace viewer URL with a {traceId} placeholder; absent when not configured. */
  traceUrlTemplate?: string
}

/** GET /api/config (static for the life of the server, so fetched once). */
export function useConfig(): AppConfig {
  const [data, setData] = useState<AppConfig>({})
  useEffect(() => {
    const ctrl = new AbortController()
    apiGet<AppConfig>('/api/config', { signal: ctrl.signal })
      .then((c) => setData(c ?? {}))
      .catch(() => {})
    return () => ctrl.abort()
  }, [])
  return data
}
