import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet } from '../../lib/api'
import type { Knight } from '../../hooks/useFleet'

/**
 * Fetches the full knight record (`/api/fleet/<name>`). Keyed on the knight's
 * identity, not the object: the fleet poll hands the drawer a fresh object
 * every 10 s and that must not refetch or reset it.
 */
export function useKnightDetail(knightName: string | undefined, knightNamespace?: string) {
  const [detail, setDetail] = useState<Knight | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)

  const fetchDetail = useCallback(async (name: string) => {
    // One detail request at a time: abort the previous one (other knight or
    // an earlier refresh) so its late response can't be rendered.
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setLoading(true)
    setError(null)
    try {
      const d = await apiGet<Knight>(`/api/fleet/${encodeURIComponent(name)}`, { signal: controller.signal })
      if (!controller.signal.aborted) setDetail(d)
    } catch (e) {
      if (!controller.signal.aborted) {
        console.error('Failed to fetch knight detail:', e)
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  const refresh = useCallback(() => {
    if (knightName) void fetchDetail(knightName)
  }, [knightName, fetchDetail])

  /** Replace the detail with a fresher record (e.g. after a snapshot), dropping any in-flight fetch. */
  const replace = useCallback((d: Knight) => {
    abort.current?.abort()
    setLoading(false)
    setDetail(d)
  }, [])

  useEffect(() => {
    if (knightName) {
      // Clear the previous knight's detail so a slow/failed fetch can't show
      // knight A's skills and config under knight B's name
      setDetail(null)
      void fetchDetail(knightName)
    }
    return () => abort.current?.abort()
  }, [knightName, knightNamespace, fetchDetail])

  return { detail, loading, error, refresh, replace }
}
