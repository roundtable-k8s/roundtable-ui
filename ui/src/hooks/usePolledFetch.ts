import { useState, useEffect, useCallback, useRef } from 'react'
import { apiGet } from '../lib/api'
import { useVisibleInterval } from './useVisibleInterval'

/**
 * Poll a JSON endpoint on an interval, pausing while the tab is hidden (#22).
 * A tick is skipped while a request is pending; it is aborted on url change and unmount.
 * Errors surface as a message string; the last good data is kept.
 */
export function usePolledFetch<T>(url: string, intervalMs: number, initial: T) {
  const [data, setData] = useState<T>(initial)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The url in force; a response for an earlier url (e.g. another table) is dropped.
  const current = useRef(url)
  const initialRef = useRef(initial)
  current.current = url

  // A new url (the table filter changed) shows no data from the old one.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    setData(initialRef.current)
    setError(null)
    setLoading(true)
  }, [url])

  const refreshWith = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await apiGet<T>(url, { signal })
      if (current.current !== url || signal?.aborted) return
      setData(next)
      setError(null)
    } catch (e) {
      if (current.current !== url || signal?.aborted) return
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      if (current.current === url && !signal?.aborted) setLoading(false)
    }
  }, [url])
  const refresh = useCallback(() => refreshWith(), [refreshWith])

  useVisibleInterval(refreshWith, intervalMs, true, { immediate: true, key: url })

  return { data, loading, error, refresh }
}
