import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { SESSION_TIMEOUT_MS } from '../../hooks/useKnightSession'
import { apiGet, apiFetch, ApiError } from '../../lib/api'
import type { SessionEntry, SessionTreeNode, SessionHistoryItem, KnightSessionStats } from '../../hooks/useKnightSession'
import type { Knight } from '../../hooks/useFleet'
import { groupSessions, podGoneFrom, parseSessionTarget, pickTargetSession, classifyIntrospectError, introspectErrorMessage, isAbortError } from '../../lib/sessions'
import { sessionHistoryKey, sessionQuery, sessionPod } from './helpers'
import { useSessionDerived } from './useSessionDerived'

export function useSessionData(knights: Knight[]) {
  // ?knight= preselects a knight (e.g. the transcript link from Task activity, #214).
  const [searchParams] = useSearchParams()
  const linkKnight = (() => {
    const k = searchParams.get('knight')?.toLowerCase() || ''
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(k) ? k : ''
  })()
  const [selectedKnight, setSelectedKnightRaw] = useState(linkKnight)
  const [view, setView] = useState<'timeline' | 'tree' | 'tools'>('timeline')
  const [entries, setEntries] = useState<SessionEntry[]>([])
  const [treeNodes, setTreeNodes] = useState<SessionTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterType, setFilterType] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [stats, setStats] = useState<KnightSessionStats | null>(null)
  // Session history / replay: 'live' = the active in-memory session; otherwise a past session id.
  const [sessions, setSessions] = useState<SessionHistoryItem[]>([])
  const [selectedSession, setSelectedSession] = useState('live')
  const [archivedMeta, setArchivedMeta] = useState<{ total: number; hasMore: boolean; startedAt: string | null } | null>(null)
  const isArchived = selectedSession !== 'live'
  // Set when the selected session's pod has been scaled away (#220): its
  // transcript can't be read, so show that instead of a spinner/timeout.
  const [podGone, setPodGone] = useState<string | null>(null)
  // ?pod=&runId= (e.g. from Task activity) focus one pod's session. Applied
  // whenever the link changes (also on in-app navigation without a remount),
  // to the knight named in the link; appliedLink is the last link applied.
  const linkKey = searchParams.toString()
  const appliedLink = useRef('')
  // Target of the link being applied, kept until the user leaves that knight
  // (so a re-run of the effect for the same knight, e.g. StrictMode, keeps it).
  const linkTarget = useRef<{ knight: string; pod: string | null; runId: string | null } | null>(null)
  // Set when a deep link names a pod on a live knight but no session was found.
  const [linkNotice, setLinkNotice] = useState<string | null>(null)
  // Switch knight and drop everything that belongs to the previous one in the
  // same batch, so no render or request mixes two knights' data.
  const setSelectedKnight = useCallback((name: string) => {
    setSelectedKnightRaw(name)
    setStats(null)
    setEntries([])
    setTreeNodes([])
    setArchivedMeta(null)
    setSelectedSession('live')
    setPodGone(null)
    setError(null)
  }, [])
  // Id of the latest fetchData call; older answers are dropped.
  const fetchSeq = useRef(0)
  const fetchAbort = useRef<AbortController | null>(null)
  useEffect(() => () => fetchAbort.current?.abort(), [])
  const groupedSessions = useMemo(() => groupSessions(sessions), [sessions])

  // Set default knight once fleet loads
  useEffect(() => {
    if (knights.length > 0 && !selectedKnight) {
      setSelectedKnight(knights[0].name)
    }
  }, [knights, selectedKnight])

  // Load the knight's past-session list; reset to the live view on knight change.
  useEffect(() => {
    if (linkKey !== appliedLink.current && linkKnight) {
      // Mark the link applied right away so a knight switch before the first
      // history response is not snapped back to the linked knight.
      appliedLink.current = linkKey
      linkTarget.current = { knight: linkKnight, ...parseSessionTarget(searchParams) }
      if (linkKnight !== selectedKnight) {
        setSelectedKnight(linkKnight) // re-runs this effect for the linked knight
        return
      }
    }
    if (!selectedKnight) return
    setSelectedSession('live')
    setArchivedMeta(null)
    setPodGone(null)
    setLinkNotice(null)
    if (linkTarget.current && linkTarget.current.knight !== selectedKnight) linkTarget.current = null
    const target = linkTarget.current ?? { pod: null, runId: null }
    let cancelled = false
    const controller = new AbortController()
    const opts = { timeoutMs: SESSION_TIMEOUT_MS, signal: controller.signal }
    apiGet<{ sessions?: SessionHistoryItem[] }>(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=history`, opts)
      .catch(e => { if (isAbortError(e)) throw e; return null })
      .then(async d => {
        if (cancelled) return
        const list: SessionHistoryItem[] = d?.sessions || []
        setSessions(list)
        const hit = pickTargetSession(list, target.pod, target.runId)
        if (hit) {
          setSelectedSession(sessionHistoryKey(hit))
        } else if (target.pod) {
          // The linked pod lists no session: ask it directly so a scaled-away
          // pod shows "pod gone" rather than an unrelated live view.
          const probe = await apiFetch(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=stats&pod=${encodeURIComponent(target.pod)}`, opts).catch(e => {
            if (isAbortError(e)) throw e
            return null
          })
          const gone = await podGoneFrom(probe, target.pod)
          if (cancelled) return
          if (gone) setPodGone(gone)
          else if (!probe || !probe.ok) setLinkNotice(`Could not reach pod ${target.pod} to check; showing the live session.`)
          else setLinkNotice(`No session found for pod ${target.pod}${target.runId ? ` in run ${target.runId}` : ''}; showing the live session.`)
        }
      })
      .catch(e => { if (!cancelled && !isAbortError(e)) setSessions([]) })
    return () => { cancelled = true; controller.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKnight, linkKey])

  const fetchData = useCallback(async () => {
    if (!selectedKnight) return

    const id = ++fetchSeq.current
    const stale = () => id !== fetchSeq.current
    fetchAbort.current?.abort()
    const controller = new AbortController()
    fetchAbort.current = controller
    const opts = { timeoutMs: SESSION_TIMEOUT_MS, signal: controller.signal }
    setLoading(true)
    setError(null)

    try {
      // Stats reflect the live session only.
      if (!isArchived) {
        apiGet<KnightSessionStats>(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=stats`, opts)
          .then(d => {
            if (stale()) return
            if (d) {
              setStats({ ...d, supported: true })
            } else {
              setStats({ knight: selectedKnight, supported: false, session: null, runtime: { uptime: 0, activeTasks: 0, model: '' } })
            }
          })
          .catch(e => {
            if (stale() || isAbortError(e)) return
            const kind = classifyIntrospectError(e)
            if (kind === 'unsupported') {
              setStats({ knight: selectedKnight, supported: false, session: null, runtime: { uptime: 0, activeTasks: 0, model: '' } })
            } else {
              // A transient failure is not "unsupported": show the error instead.
              setStats(null)
              setError(introspectErrorMessage(kind))
            }
          })
      }

      // Archived session: replay its persisted entries (timeline/tools views).
      if (isArchived) {
        const res = await apiFetch(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=session&${sessionQuery(selectedSession)}&limit=300`, opts)
        const gone = await podGoneFrom(res, sessionPod(selectedSession))
        if (stale()) return
        if (gone) {
          setPodGone(gone)
          setEntries([])
          setArchivedMeta(null)
          return
        }
        setPodGone(null)
        if (!res.ok) {
          setEntries([])
          setArchivedMeta(null)
          const kind = classifyIntrospectError(new ApiError(res.status, ''))
          if (kind !== 'unsupported') setError(introspectErrorMessage(kind))
          return
        }
        const data = await res.json()
        if (stale()) return
        setEntries(data.entries || [])
        setTreeNodes([])
        setArchivedMeta({ total: data.total ?? 0, hasMore: !!data.hasMore, startedAt: data.startedAt ?? null })
        return
      }

      if (view === 'tree') {
        const data = await apiGet<{ nodes?: SessionTreeNode[] }>(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=tree`, opts)
        if (stale()) return
        setTreeNodes(data.nodes || [])
      } else {
        const data = await apiGet<{ entries?: SessionEntry[] }>(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=recent&limit=100`, opts)
        if (stale()) return
        setEntries(data.entries || [])
      }
    } catch (e) {
      if (stale() || isAbortError(e)) return
      const kind = classifyIntrospectError(e)
      if (kind === 'unsupported') {
        if (view === 'tree') setTreeNodes([]); else setEntries([])
      } else {
        setError(introspectErrorMessage(kind))
      }
    } finally {
      if (!stale()) setLoading(false)
    }
  }, [selectedKnight, view, selectedSession, isArchived])

  useEffect(() => { fetchData() }, [fetchData])

  const derived = useSessionDerived(entries, treeNodes, view, filterType, searchQuery)

  return {
    selectedKnight, setSelectedKnight, view, setView, filterType, setFilterType, searchQuery, setSearchQuery,
    stats, loading, error, sessions, groupedSessions, selectedSession, setSelectedSession, archivedMeta, isArchived,
    podGone, setPodGone, linkNotice, fetchData, ...derived,
  }
}
