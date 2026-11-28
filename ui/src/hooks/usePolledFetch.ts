import { useCallback, useRef, useSyncExternalStore } from 'react'
import * as store from '../lib/polledStore'

/**
 * Poll a JSON endpoint on an interval, pausing while the tab is hidden (#22).
 * Components using the same url share one request (see lib/polledStore): one in flight
 * per url, polled at the smallest interval any of them asks for.
 * Errors surface as a message string; the last good data is kept.
 * A null url means "do not fetch" (returns `initial`, loading: false); intervalMs <= 0
 * fetches once per url (refresh() still refetches).
 */
export function usePolledFetch<T>(rawUrl: string | null, intervalMs: number, initial: T) {
  const initialRef = useRef(initial)
  const url = rawUrl ?? ''
  const subscribe = useCallback(
    (cb: () => void) => (rawUrl === null ? () => {} : store.subscribe(url, intervalMs, cb)),
    [rawUrl, url, intervalMs],
  )
  const snap = useSyncExternalStore(subscribe, () => (rawUrl === null ? store.getSnapshot('') : store.getSnapshot(url)))
  const refresh = useCallback(() => store.refresh(url), [url])

  if (rawUrl === null) return { data: initialRef.current, loading: false, error: null, errorStatus: undefined, updatedAt: null, refresh }
  return {
    data: snap.hasData ? (snap.data as T) : initialRef.current,
    loading: snap.loading,
    error: snap.error,
    errorStatus: snap.errorStatus,
    updatedAt: snap.updatedAt,
    refresh,
  }
}
