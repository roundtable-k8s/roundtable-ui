import { useEffect, useState } from 'react'
import { apiGet } from '../lib/api'

export interface AppConfig {
  fleetPrefix?: string
  /** Trace viewer URL with a {traceId} placeholder; absent when not configured. */
  traceUrlTemplate?: string
}

// One shared request for the whole page; cleared on failure so a later mount retries.
let cached: Promise<AppConfig> | null = null

function loadConfig(): Promise<AppConfig> {
  if (!cached) {
    const p: Promise<AppConfig> = apiGet<AppConfig>('/api/config')
      .then((c) => c ?? {})
      .catch((e) => {
        if (cached === p) cached = null
        throw e
      })
    cached = p
  }
  return cached
}

/** Clear the shared config request (tests). */
export function resetConfigCache() {
  cached = null
}

/** GET /api/config (static for the life of the server, so fetched once). */
export function useConfig(): AppConfig {
  const [data, setData] = useState<AppConfig>({})
  useEffect(() => {
    let live = true
    loadConfig().then((c) => { if (live) setData(c) }).catch(() => {})
    return () => { live = false }
  }, [])
  return data
}
