import { useState, useCallback, useRef, useEffect } from 'react'
import { apiGet } from '../lib/api'
import { useVisibleInterval } from './useVisibleInterval'

/** HTTP status of an ApiError (duck-typed so mocked api modules work). */
function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : undefined
}

interface PolledState<T> { url: string; data: T; error: string | null; errorStatus?: number; loading: boolean; updatedAt: number | null }

/**
 * Poll a JSON endpoint on an interval, pausing while the tab is hidden (#22).
 * A tick is skipped while a request is pending; it is aborted on url change and unmount.
 * Errors surface as a message string; the last good data is kept.
 * A null url means "do not fetch" (returns `initial`, loading: false); intervalMs <= 0
 * fetches once per url (refresh() still refetches).
 */
export function usePolledFetch<T>(rawUrl: string | null, intervalMs: number, initial: T) {
  const enabled = rawUrl !== null
  const url = rawUrl ?? ''
  // State is keyed by the url it was fetched for, so a url change (e.g. the
  // table filter) never renders the previous url's data, even for one frame.
  const [state, setState] = useState<PolledState<T>>({ url, data: initial, error: null, loading: true, updatedAt: null })

  // Accepted: switching A -> B -> A before B answers shows A's earlier data
  // with loading: false, because the state still belongs to url A.

  // The url in force; a response for an earlier url (e.g. another table) is dropped.
  const current = useRef(url)
  const initialRef = useRef(initial)
  current.current = url

  const update = useCallback((patch: Partial<PolledState<T>>) => {
    setState((prev) => {
      const base: PolledState<T> = prev.url === url
        ? prev
        : { url, data: initialRef.current, error: null, loading: true, updatedAt: null }
      return { ...base, ...patch }
    })
  }, [url])

  const refreshWith = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await apiGet<T>(url, { signal })
      if (current.current !== url || signal?.aborted) return
      update({ data: next, error: null, errorStatus: undefined, loading: false, updatedAt: Date.now() })
    } catch (e) {
      if (current.current !== url || signal?.aborted) return
      update({ error: e instanceof Error ? e.message : 'Unknown error', errorStatus: statusOf(e), loading: false })
    }
  }, [url, update])
  const refresh = useCallback(() => refreshWith(), [refreshWith])

  const polling = enabled && intervalMs > 0
  useVisibleInterval(refreshWith, intervalMs, polling, { immediate: true, key: url })

  const once = enabled && !(intervalMs > 0)
  useEffect(() => {
    if (!once) return
    const ctrl = new AbortController()
    void refreshWith(ctrl.signal)
    return () => ctrl.abort()
  }, [once, refreshWith])

  if (!enabled) return { data: initialRef.current, loading: false, error: null, errorStatus: undefined, updatedAt: null, refresh }
  if (state.url !== url) return { data: initialRef.current, loading: true, error: null, errorStatus: undefined, updatedAt: null, refresh }
  return { data: state.data, loading: state.loading, error: state.error, errorStatus: state.errorStatus, updatedAt: state.updatedAt, refresh }
}
