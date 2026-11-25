import { useState, useEffect, useCallback, useRef } from 'react'
import { apiGet } from '../lib/api'

/**
 * Poll a JSON endpoint on an interval, pausing while the tab is hidden (#22).
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

  const refresh = useCallback(async () => {
    try {
      const next = await apiGet<T>(url)
      if (current.current !== url) return
      setData(next)
      setError(null)
    } catch (e) {
      if (current.current !== url) return
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      if (current.current === url) setLoading(false)
    }
  }, [url])

  useEffect(() => {
    refresh()
    let interval: ReturnType<typeof setInterval> | null = null

    const startPolling = () => {
      if (!interval) interval = setInterval(refresh, intervalMs)
    }
    const stopPolling = () => {
      if (interval) { clearInterval(interval); interval = null }
    }
    const onVisibility = () => {
      if (document.hidden) { stopPolling() } else { startPolling(); refresh() }
    }

    startPolling()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh, intervalMs])

  return { data, loading, error, refresh }
}
