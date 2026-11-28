import { useState, useCallback, useRef, useEffect } from 'react'
import { apiGet } from '../lib/api'
import { classifyIntrospectError, introspectErrorMessage, isAbortError } from '../lib/sessions'

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

export function useKnightSession() {
  const [stats, setStats] = useState<KnightSessionStats | null>(null)
  const [recent, setRecent] = useState<SessionEntry[]>([])
  const [tree, setTree] = useState<SessionTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Latest request id per kind: a response for an older request (another
  // knight, or a superseded refresh) must not overwrite newer state.
  const latest = useRef({ stats: 0, recent: 0, tree: 0 })

  // In-flight request per kind, so a newer request or a knight change cancels
  // the older one (the API then stops its NATS fan-out for it).
  const controllers = useRef<Partial<Record<'stats' | 'recent' | 'tree', AbortController>>>({})
  const begin = useCallback((kind: 'stats' | 'recent' | 'tree') => {
    controllers.current[kind]?.abort()
    const c = new AbortController()
    controllers.current[kind] = c
    return c.signal
  }, [])
  useEffect(() => () => {
    for (const c of Object.values(controllers.current)) c?.abort()
  }, [])

  const fetchStats = useCallback(async (knight: string, timeoutMs = SESSION_TIMEOUT_MS) => {
    const id = ++latest.current.stats
    const stale = () => id !== latest.current.stats
    const signal = begin('stats')
    setLoading(true)
    setError(null)
    try {
      const data = await apiGet<KnightSessionStats>(`/api/fleet/${encodeURIComponent(knight)}/session?type=stats`, { timeoutMs, signal })
      if (stale()) return
      setStats({ ...data, supported: true })
    } catch (e) {
      if (stale() || isAbortError(e)) return
      const kind = classifyIntrospectError(e)
      if (kind === 'unsupported') {
        setStats({ knight, supported: false, session: null, runtime: { uptime: 0, activeTasks: 0, model: '' } })
      } else {
        // A transient failure is not "unsupported": keep supported unset and show the error.
        setError(introspectErrorMessage(kind))
      }
    } finally {
      if (!stale()) setLoading(false)
    }
  }, [begin])

  const fetchRecent = useCallback(async (knight: string, limit = 20, timeoutMs = SESSION_TIMEOUT_MS) => {
    const id = ++latest.current.recent
    const stale = () => id !== latest.current.recent
    const signal = begin('recent')
    try {
      const data = await apiGet<{ entries?: SessionEntry[] }>(`/api/fleet/${encodeURIComponent(knight)}/session?type=recent&limit=${limit}`, { timeoutMs, signal })
      if (stale()) return
      setRecent(data?.entries || [])
    } catch (e) {
      if (stale() || isAbortError(e)) return
      setRecent([])
      const kind = classifyIntrospectError(e)
      if (kind !== 'unsupported') setError(introspectErrorMessage(kind))
    }
  }, [begin])

  const fetchTree = useCallback(async (knight: string, timeoutMs = SESSION_TIMEOUT_MS) => {
    const id = ++latest.current.tree
    const stale = () => id !== latest.current.tree
    const signal = begin('tree')
    try {
      const data = await apiGet<{ nodes?: SessionTreeNode[] }>(`/api/fleet/${encodeURIComponent(knight)}/session?type=tree`, { timeoutMs, signal })
      if (stale()) return
      setTree(data?.nodes || [])
    } catch (e) {
      if (stale() || isAbortError(e)) return
      setTree([])
      const kind = classifyIntrospectError(e)
      if (kind !== 'unsupported') setError(introspectErrorMessage(kind))
    }
  }, [begin])

  // Drop the current knight's data (and invalidate in-flight requests) when the knight changes.
  const reset = useCallback(() => {
    for (const c of Object.values(controllers.current)) c?.abort()
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
