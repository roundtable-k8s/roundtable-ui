import { useEffect, useRef, useState } from 'react'
import { eventKey, type NatsEvent } from './useWebSocket'
import { parseEvent, resultFailureReason } from '../lib/events'

const MAX_SEEN_KEYS = 1000

export interface TitleBadge {
  /** Live results that arrived while the tab was hidden */
  count: number
  /** How many of those failed */
  failed: number
}

const EMPTY: TitleBadge = { count: 0, failed: 0 }

/**
 * Count live result events that arrive while the tab is hidden, so the
 * document title can show that something finished in the background.
 * Seeded history never counts (no `live` flag). Showing the tab again
 * resets the count.
 */
export function useTitleBadge(events: NatsEvent[]): TitleBadge {
  const [badge, setBadge] = useState<TitleBadge>(EMPTY)
  const seenKeys = useRef(new Set<string>())

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) setBadge(EMPTY)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    const seen = seenKeys.current
    const fresh = events.filter((e) => !seen.has(eventKey(e)))
    if (fresh.length === 0) return

    for (const e of fresh) seen.add(eventKey(e))
    if (seen.size > MAX_SEEN_KEYS) {
      const keys = Array.from(seen)
      seenKeys.current = new Set(keys.slice(keys.length - MAX_SEEN_KEYS / 2))
    }

    if (!document.hidden) return
    let count = 0
    let failed = 0
    for (const e of fresh) {
      if (!e.live || e.type !== 'result') continue
      count++
      if (resultFailureReason(parseEvent(e).data)) failed++
    }
    if (count === 0) return
    setBadge((b) => ({ count: b.count + count, failed: b.failed + failed }))
  }, [events])

  return badge
}

/** Document title with the badge prefix, e.g. `(2, 1 failed) Fleet - Round Table`. */
export function badgedTitle(badge: TitleBadge, base: string): string {
  if (badge.count === 0) return base
  const detail = badge.failed > 0 ? `${badge.count}, ${badge.failed} failed` : `${badge.count}`
  return `(${detail}) ${base}`
}
