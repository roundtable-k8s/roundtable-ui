import { useRef } from 'react'
import { apiGet, ApiError } from '../lib/api'
import { useVisibleInterval } from './useVisibleInterval'

export interface TaskPollerOptions<Item, Remote> {
  items: Item[]
  idOf: (item: Item) => string
  /** Items that are done are not polled. */
  isDone: (item: Item) => boolean
  fetchUrl: (item: Item) => string
  /** Called with each successful response. */
  onUpdate: (id: string, remote: Remote) => void
  /** Called once after `maxFailures` consecutive failures, or on a 404 with `giveUpOn404`. */
  onGiveUp?: (id: string, error: unknown) => void
  /** Consecutive failures before giving up. Default 5; Infinity retries forever. */
  maxFailures?: number
  giveUpOn404?: boolean
  intervalMs?: number
}

/**
 * Follow items until they are done: polls every not-done item each interval
 * (paused while the tab is hidden), resets the failure counter on success.
 */
export function useTaskPoller<Item, Remote>({
  items, idOf, isDone, fetchUrl, onUpdate, onGiveUp,
  maxFailures = 5, giveUpOn404 = false, intervalMs = 2000,
}: TaskPollerOptions<Item, Remote>): void {
  const failures = useRef(new Map<string, number>())
  const pending = items.filter((i) => !isDone(i))
  const key = pending.map(idOf).join(',')
  const latest = { pending, idOf, fetchUrl, onUpdate, onGiveUp, maxFailures, giveUpOn404 }
  const ref = useRef(latest)
  ref.current = latest

  useVisibleInterval(
    (signal) => {
      const c = ref.current
      // Resolves with the first failure (if any) so useVisibleInterval can back off on 429/5xx.
      return Promise.all(c.pending.map((item): Promise<unknown> => {
        const id = c.idOf(item)
        return apiGet<Remote>(c.fetchUrl(item), { signal })
          .then((r) => {
            failures.current.delete(id)
            c.onUpdate(id, r)
          })
          .catch((e: unknown) => {
            if (signal.aborted) return undefined
            if (c.giveUpOn404 && e instanceof ApiError && e.status === 404) {
              failures.current.delete(id)
              c.onGiveUp?.(id, e)
              return undefined
            }
            const n = (failures.current.get(id) ?? 0) + 1
            failures.current.set(id, n)
            if (n >= c.maxFailures) {
              failures.current.delete(id)
              c.onGiveUp?.(id, e)
            }
            return e
          })
      })).then((results) => results.find((r) => r !== undefined))
    },
    intervalMs,
    key !== '',
    { key },
  )
}
