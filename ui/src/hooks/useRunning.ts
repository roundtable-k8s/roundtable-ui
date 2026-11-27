import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, ApiError } from '../lib/api'
import { useWebSocket } from './useWebSocket'
import {
  applyRunningDelta,
  parseRunningDelta,
  parseRunningResponse,
  type RunningMap,
  type RunningTask,
} from '../lib/running'

export interface RunningState {
  tasks: RunningMap
  loading: boolean
  error: string | null
  /** The API has no /api/running endpoint (older backend). */
  unavailable: boolean
  /** Re-fetch the snapshot (used by the Retry button). */
  refresh: () => void
}

/**
 * Live in-flight task registry: a GET /api/running snapshot, kept current by
 * `running` WebSocket deltas. Re-syncs on every (re)connect so deltas missed
 * while disconnected don't leave ghost or missing rows.
 */
export function useRunning(): RunningState {
  const { connected, subscribeTopic } = useWebSocket()
  const [tasks, setTasks] = useState<RunningMap>(() => new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  // Deltas seen while a snapshot fetch is in flight; replayed on top of the
  // snapshot so a task that finished (or started) mid-fetch isn't lost.
  const pending = useRef<Map<string, RunningTask | null> | null>(null)

  useEffect(() => subscribeTopic('running', (data) => {
    const delta = parseRunningDelta(data)
    if (!delta) return
    if (pending.current) {
      if (delta.op === 'upsert') pending.current.set(delta.task.taskId, delta.task)
      else if (delta.op === 'remove') pending.current.set(delta.taskId, null)
      else pending.current.clear()
    }
    setTasks((prev) => applyRunningDelta(prev, delta))
  }), [subscribeTopic])

  // Fetch on mount (even if the live feed is down) and on every reconnect.
  const fetched = useRef(false)
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = useCallback(() => setReloadKey((k) => k + 1), [])
  const lastReload = useRef(0)
  useEffect(() => {
    const manual = reloadKey !== lastReload.current
    lastReload.current = reloadKey
    if (!connected && fetched.current && !manual) return
    fetched.current = true
    const controller = new AbortController()
    const replay = new Map<string, RunningTask | null>()
    pending.current = replay
    setLoading(true)
    apiGet<unknown>('/api/running', { signal: controller.signal })
      .then((body) => {
        if (controller.signal.aborted) return
        const next = parseRunningResponse(body)
        for (const [id, t] of replay) {
          if (t) next.set(id, t)
          else next.delete(id)
        }
        setTasks(next)
        setError(null)
        setUnavailable(false)
      })
      .catch((e) => {
        if (controller.signal.aborted || (e as Error)?.name === 'AbortError') return
        if (e instanceof ApiError && e.status === 404) setUnavailable(true)
        else setError(e instanceof Error ? e.message : 'Failed to load running tasks')
      })
      .finally(() => {
        if (pending.current === replay) pending.current = null
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [connected, reloadKey])

  return { tasks, loading, error, unavailable, refresh }
}
