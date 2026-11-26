import { useState, useCallback, useRef } from 'react'
import { apiGet } from '../lib/api'
import { useVisibleInterval } from './useVisibleInterval'

interface PolledState<T> { url: string; data: T; error: string | null; loading: boolean }

/**
 * Poll a JSON endpoint on an interval, pausing while the tab is hidden (#22).
 * A tick is skipped while a request is pending; it is aborted on url change and unmount.
 * Errors surface as a message string; the last good data is kept.
 */
export function usePolledFetch<T>(url: string, intervalMs: number, initial: T) {
  // State is keyed by the url it was fetched for, so a url change (e.g. the
  // table filter) never renders the previous url's data, even for one frame.
  const [state, setState] = useState<PolledState<T>>({ url, data: initial, error: null, loading: true })

  // The url in force; a response for an earlier url (e.g. another table) is dropped.
  const current = useRef(url)
  const initialRef = useRef(initial)
  current.current = url

  const update = useCallback((patch: Partial<PolledState<T>>) => {
    setState((prev) => {
      const base: PolledState<T> = prev.url === url
        ? prev
        : { url, data: initialRef.current, error: null, loading: true }
      return { ...base, ...patch }
    })
  }, [url])

  const refreshWith = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await apiGet<T>(url, { signal })
      if (current.current !== url || signal?.aborted) return
      update({ data: next, error: null, loading: false })
    } catch (e) {
      if (current.current !== url || signal?.aborted) return
      update({ error: e instanceof Error ? e.message : 'Unknown error', loading: false })
    }
  }, [url, update])
  const refresh = useCallback(() => refreshWith(), [refreshWith])

  useVisibleInterval(refreshWith, intervalMs, true, { immediate: true, key: url })

  if (state.url !== url) return { data: initialRef.current, loading: true, error: null, refresh }
  return { data: state.data, loading: state.loading, error: state.error, refresh }
}
