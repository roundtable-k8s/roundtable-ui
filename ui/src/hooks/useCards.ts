import { useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from '../lib/api'
import { useWebSocket } from './useWebSocket'
import { applyCardPush, parseCardPush, parseCardsResponse, type CardMap, type CardPush } from '../lib/cards'

export interface CardsState {
  cards: CardMap
  loading: boolean
  /** The API has no /api/cards endpoint (older backend): show the fleet without cards. */
  unavailable: boolean
}

/**
 * Knight agent cards (#243): a GET /api/cards snapshot kept current by `cards`
 * WebSocket pushes. Re-syncs on every (re)connect. Errors are swallowed on
 * purpose: cards are an enhancement, the fleet view works without them.
 */
export function useCards(): CardsState {
  const { connected, subscribeTopic } = useWebSocket()
  const [cards, setCards] = useState<CardMap>(() => new Map())
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  // Pushes seen while a snapshot is loading, replayed on top of it.
  const pending = useRef<CardPush[] | null>(null)

  useEffect(() => subscribeTopic('cards', (data) => {
    const push = parseCardPush(data)
    if (!push) return
    pending.current?.push(push)
    setCards((prev) => applyCardPush(prev, push))
  }), [subscribeTopic])

  const fetched = useRef(false)
  useEffect(() => {
    if (!connected && fetched.current) return
    fetched.current = true
    const controller = new AbortController()
    const replay: CardPush[] = []
    pending.current = replay
    setLoading(true)
    apiGet<unknown>('/api/cards', { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return
        setCards(replay.reduce(applyCardPush, parseCardsResponse(body)))
        setUnavailable(false)
      })
      .catch((e) => {
        if (controller.signal.aborted || (e as Error)?.name === 'AbortError') return
        if (e instanceof ApiError && e.status === 404) setUnavailable(true)
      })
      .finally(() => {
        if (pending.current === replay) pending.current = null
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [connected])

  return { cards, loading, unavailable }
}
