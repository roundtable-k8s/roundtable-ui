import { usePolledFetch } from './usePolledFetch'
import type { Mission } from './useMissions'

/** One mission, polled every 10 s. `notFound` is true when the API answers 404. */
export function useMission(name: string, refreshInterval = 10000) {
  const { data, loading, error, errorStatus, refresh } = usePolledFetch<Mission | null>(
    '/api/missions/' + encodeURIComponent(name), refreshInterval, null)
  const notFound = errorStatus === 404
  return { mission: notFound ? null : data, loading, error: notFound ? null : error, notFound, refresh }
}
