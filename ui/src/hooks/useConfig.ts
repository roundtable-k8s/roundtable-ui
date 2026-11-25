import { usePolledFetch } from './usePolledFetch'

export interface AppConfig {
  fleetPrefix?: string
  /** Trace viewer URL with a {traceId} placeholder; absent when not configured. */
  traceUrlTemplate?: string
}

/** GET /api/config (static for the life of the server, so polled rarely). */
export function useConfig(): AppConfig {
  const { data } = usePolledFetch<AppConfig>('/api/config', 600000, {})
  return data ?? {}
}
