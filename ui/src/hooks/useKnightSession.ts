import { useState, useCallback, useRef } from 'react'
import { apiFetch } from '../lib/api'

// Matches pi-knight's introspect stats response (src/introspect.ts buildStats)
export interface KnightSessionStats {
  knight: string
  supported?: boolean  // whether knight responded to introspect
  session: {
    sessionId: string
    userMessages: number
    assistantMessages: number
    toolCalls: number
    totalMessages: number
    tokens: { input: number; output: number; total: number }
    cost: number
  } | null
  runtime: {
    uptime: number
    activeTasks: number
    model: string
  }
  // Per-pod fan-out (#219): the API sums every ready pod's stats into the
  // fields above and keeps each pod's own reply here.
  pods?: PodStatsBreakdown[]
  podCount?: number
  respondedPods?: number
}

// One pod's entry in an aggregated stats/history reply.
export interface PodStatsBreakdown {
  pod: string
  ok: boolean
  error?: string
  stats?: Partial<Omit<KnightSessionStats, 'pods'>>
}

export interface SessionEntry {
  id: string
  parentId: string | null
  type: string
  timestamp: string
  role?: string
  text?: string
  toolName?: string
  input?: string
  output?: string
  cost?: number
  tokens?: { input: number; output: number }
}

// One past (persisted) session in a knight's history list (introspect type=history).
export interface SessionHistoryItem {
  id: string
  startedAt: string | null
  entryCount: number
  messageCount: number
  firstPrompt: string
  sizeBytes: number | null
  pod?: string  // pod the session lives on (set by the API's per-pod fan-out)
  runId?: string  // run (chain/mission run) the session belongs to, when the runtime reports it
}

export interface SessionTreeNode {
  id: string
  parentId: string | null
  type: string
  timestamp: string
  label?: string
  childrenCount: number
  summary: string
}

// Client-side timeout must exceed the API's 5s NATS introspect timeout —
// otherwise the client aborts first and a slow knight looks "unsupported"
export const SESSION_TIMEOUT_MS = 8000

// Helper to add timeout to fetch requests
export async function fetchWithTimeout(url: string, timeoutMs = SESSION_TIMEOUT_MS): Promise<Response | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  
  try {
    // timeoutMs: 0 — this helper's own timer decides, so an AbortError here means "no answer in time"
    const res = await apiFetch(url, { signal: controller.signal, timeoutMs: 0 })
    clearTimeout(timeout)
    return res
  } catch (e) {
    clearTimeout(timeout)
    if ((e as Error).name === 'AbortError') {
      return null  // timeout - knight doesn't support introspect
    }
    throw e
  }
}

export function useKnightSession() {
  const [stats, setStats] = useState<KnightSessionStats | null>(null)
  const [recent, setRecent] = useState<SessionEntry[]>([])
  const [tree, setTree] = useState<SessionTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Latest request id per kind: a response for an older request (another
  // knight, or a superseded refresh) must not overwrite newer state.
  const latest = useRef({ stats: 0, recent: 0, tree: 0 })

  const fetchStats = useCallback(async (knight: string, timeoutMs = SESSION_TIMEOUT_MS) => {
    const id = ++latest.current.stats
    const stale = () => id !== latest.current.stats
    setLoading(true)
    setError(null)
    try {
      const res = await fetchWithTimeout(`/api/fleet/${encodeURIComponent(knight)}/session?type=stats`, timeoutMs)
      if (!res) {
        // Knight doesn't support introspect - not an error
        if (stale()) return
        setStats({ knight, supported: false, session: null, runtime: { uptime: 0, activeTasks: 0, model: '' } })
        return
      }
      if (!res.ok) {
        if (stale()) return
        setStats({ knight, supported: false, session: null, runtime: { uptime: 0, activeTasks: 0, model: '' } })
        return
      }
      const data = await res.json()
      if (stale()) return
      setStats({ ...data, supported: true })
    } catch (e) {
      // Graceful failure - return null instead of throwing
      if (stale()) return
      setStats({ knight, supported: false, session: null, runtime: { uptime: 0, activeTasks: 0, model: '' } })
      setError(null)  // Don't show error for unsupported knights
    } finally {
      if (!stale()) setLoading(false)
    }
  }, [])

  const fetchRecent = useCallback(async (knight: string, limit = 20, timeoutMs = SESSION_TIMEOUT_MS) => {
    const id = ++latest.current.recent
    const stale = () => id !== latest.current.recent
    try {
      const res = await fetchWithTimeout(`/api/fleet/${encodeURIComponent(knight)}/session?type=recent&limit=${limit}`, timeoutMs)
      if (!res || !res.ok) {
        if (stale()) return
        setRecent([])
        return
      }
      const data = await res.json()
      if (stale()) return
      setRecent(data.entries || [])
    } catch (e) {
      if (stale()) return
      setRecent([])
      setError(null)
    }
  }, [])

  const fetchTree = useCallback(async (knight: string, timeoutMs = SESSION_TIMEOUT_MS) => {
    const id = ++latest.current.tree
    const stale = () => id !== latest.current.tree
    try {
      const res = await fetchWithTimeout(`/api/fleet/${encodeURIComponent(knight)}/session?type=tree`, timeoutMs)
      if (!res || !res.ok) {
        if (stale()) return
        setTree([])
        return
      }
      const data = await res.json()
      if (stale()) return
      setTree(data.nodes || [])
    } catch (e) {
      if (stale()) return
      setTree([])
      setError(null)
    }
  }, [])

  // Drop the current knight's data (and invalidate in-flight requests) when the knight changes.
  const reset = useCallback(() => {
    latest.current.stats++
    latest.current.recent++
    latest.current.tree++
    setStats(null)
    setRecent([])
    setTree([])
    setError(null)
  }, [])

  return { stats, recent, tree, loading, error, fetchStats, fetchRecent, fetchTree, reset }
}
