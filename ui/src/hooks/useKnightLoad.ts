import { useMemo } from 'react'
import { usePolledFetch } from './usePolledFetch'
import { namespacedKey } from '../lib/keys'

/** Queued (waiting) and in-flight (running) task counts of one knight. */
export interface KnightQueue { pending: number; inFlight: number }

/** Queue counts keyed by `namespace/name` (see namespacedKey). */
export type KnightLoadMap = Map<string, KnightQueue>

/** Map key for a knight: `namespace/name`, the namespace empty when unset. */

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0

/**
 * Reads GET /api/chat/knights?load=true: {knights:[...]} or a bare array.
 * Knights without a `queue` (gateway could not read NATS) are left out.
 */
export function parseKnightLoad(data: unknown): KnightLoadMap {
  const out: KnightLoadMap = new Map()
  const list = Array.isArray(data) ? data : (data as { knights?: unknown } | null)?.knights
  if (!Array.isArray(list)) return out
  for (const k of list) {
    if (!k || typeof k !== 'object') continue
    const { name, namespace, queue } = k as { name?: unknown; namespace?: unknown; queue?: { pending?: unknown; inFlight?: unknown } }
    if (typeof name !== 'string' || name === '' || !queue) continue
    if (!isCount(queue.pending) || !isCount(queue.inFlight)) continue
    const ns = typeof namespace === 'string' ? namespace : undefined
    out.set(namespacedKey({ name, namespace: ns }), { pending: queue.pending, inFlight: queue.inFlight })
  }
  return out
}

const EMPTY: KnightLoadMap = new Map()
const NO_DATA: unknown = null

/**
 * Queue counts per knight for the Fleet cards, polled every 15 s. Any error
 * (gateway not configured, 503) gives an empty map: the fleet view then shows
 * no load, without a banner.
 */
export function useKnightLoad(): KnightLoadMap {
  const { data, error } = usePolledFetch<unknown>('/api/chat/knights?load=true', 15000, NO_DATA)
  return useMemo(() => (error ? EMPTY : parseKnightLoad(data)), [data, error])
}
