import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { TreePine, ChevronRight, ChevronDown, Wrench, MessageSquare, Search, BarChart3, History, ServerOff } from 'lucide-react'
import { getKnightConfig, buildKnightConfigFromFleet } from '../lib/knights'
import { useFleet } from '../hooks/useFleet'
import { fetchWithTimeout } from '../hooks/useKnightSession'
import type { SessionEntry, SessionTreeNode, SessionHistoryItem, KnightSessionStats } from '../hooks/useKnightSession'
import { Spinner, ErrorBanner, EmptyState, PageHeader, RefreshButton, StatCard, ProgressBar } from '../components/ui'
import { formatCost, formatDateTime, formatTimestampOrDate, formatNumber } from '../lib/format'
import { UntrustedText } from '../components/UntrustedText'
import { SessionEntryCard } from '../components/SessionEntryCard'
import { entryTypeIcons } from '../lib/sessionEntries'
import { sanitizeText } from '../lib/untrusted'
import { groupSessions, groupLabel, podGoneFrom, parseSessionTarget, pickTargetSession } from '../lib/sessions'

// Cap the visual indent so a long, near-linear parent→child chain doesn't
// march the content off the right edge (and squeeze the timestamp into a wrap).
const MAX_TREE_INDENT_DEPTH = 12
const TREE_INDENT_PX = 16

// Human label for a past session in the picker: when it ran, message count, and the opening prompt.
function sessionLabel(s: SessionHistoryItem): string {
  const when = s.startedAt ? formatDateTime(s.startedAt) : 'unknown time'
  const prompt = s.firstPrompt ? ` — ${s.firstPrompt.slice(0, 60)}` : ''
  return `${when} · ${s.messageCount} msgs${prompt}`
}

// Picker value for a past session: "<pod>/<id>" so the transcript is always
// fetched from the pod it lives on (#219). Neither pod names nor session ids
// contain "/".
export function sessionHistoryKey(s: SessionHistoryItem): string {
  return s.pod ? `${s.pod}/${s.id}` : s.id
}

// Query string selecting a past session from its picker value.
export function sessionQuery(key: string): string {
  const slash = key.indexOf('/')
  if (slash < 0) return `id=${encodeURIComponent(key)}`
  return `id=${encodeURIComponent(key.slice(slash + 1))}&pod=${encodeURIComponent(key.slice(0, slash))}`
}

// Pod named in a picker value ("<pod>/<id>"), or null for a bare id.
export function sessionPod(key: string): string | null {
  const slash = key.indexOf('/')
  return slash < 0 ? null : key.slice(0, slash)
}

// Shown instead of a transcript whose pod has been scaled away (#220).
export function PodGoneNotice({ pod, onBack }: { pod: string; onBack?: () => void }) {
  return (
    <div role="status" className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-4 mb-4 flex items-start gap-3 text-sm">
      <ServerOff className="w-5 h-5 text-gray-400 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <p className="text-gray-200 font-medium">
          Pod gone: <code className="break-all">{sanitizeText(pod)}</code> has been scaled away
        </p>
        <p className="text-gray-400 mt-1">
          Its session transcript lived in that pod and can no longer be read. See the task's activity and result on
          the <Link to="/running" className="text-roundtable-gold hover:underline">Running</Link> page instead.
        </p>
      </div>
      {onBack && (
        <button onClick={onBack} className="text-roundtable-gold hover:underline shrink-0">← Back to live</button>
      )}
    </div>
  )
}

export function TreeNodeView({ node, depth = 0 }: { node: SessionTreeNode & { children?: SessionTreeNode[] }; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = (node.children?.length ?? 0) > 0
  const indent = Math.min(depth, MAX_TREE_INDENT_DEPTH) * TREE_INDENT_PX

  return (
    <div>
      <div
        className="flex items-center gap-2 py-1 pr-2 rounded hover:bg-roundtable-steel/30 cursor-pointer text-sm"
        onClick={() => setExpanded(e => !e)}
      >
        {/* Indented label region — only this shrinks/truncates, keeping the
            timestamp pinned to a fixed right column. */}
        <div className="flex items-center gap-2 min-w-0 flex-1" style={{ paddingLeft: indent }}>
          {hasChildren ? (
            expanded
              ? <ChevronDown className="w-3 h-3 text-gray-500 shrink-0" />
              : <ChevronRight className="w-3 h-3 text-gray-500 shrink-0" />
          ) : <span className="w-3 shrink-0" />}
          <span className="shrink-0">{entryTypeIcons[node.type] || '●'}</span>
          <span className="text-gray-300 truncate">{node.summary || node.label || node.type}</span>
        </div>
        {node.childrenCount > 0 && (
          <span className="text-xs text-gray-600 shrink-0">{node.childrenCount}</span>
        )}
        <span className="text-xs text-gray-600 shrink-0 whitespace-nowrap tabular-nums">{formatTimestampOrDate(node.timestamp)}</span>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children?.map(child => (
            <TreeNodeView key={child.id} node={child as SessionTreeNode & { children?: SessionTreeNode[] }} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolCallCard({ entry }: { entry: SessionEntry }) {
  return <SessionEntryCard entry={entry} density="page" />
}

export function SessionsPage() {
  const { knights, loading: fleetLoading } = useFleet()
  // ?knight= preselects a knight (e.g. the transcript link from Task activity, #214).
  const [searchParams] = useSearchParams()
  const linkKnight = (() => {
    const k = searchParams.get('knight')?.toLowerCase() || ''
    return /^[a-z0-9][a-z0-9-]{0,62}$/.test(k) ? k : ''
  })()
  const [selectedKnight, setSelectedKnight] = useState(linkKnight)
  const [view, setView] = useState<'timeline' | 'tree' | 'tools'>('timeline')
  const [entries, setEntries] = useState<SessionEntry[]>([])
  const [treeNodes, setTreeNodes] = useState<SessionTreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filterType, setFilterType] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [knightSearchQuery, setKnightSearchQuery] = useState('')
  const [stats, setStats] = useState<KnightSessionStats | null>(null)
  const [allKnightStats, setAllKnightStats] = useState<Record<string, KnightSessionStats>>({})
  const [showFleetPerf, setShowFleetPerf] = useState(false)
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
  const groupedSessions = useMemo(() => groupSessions(sessions), [sessions])

  // Build dynamic knight config from fleet
  const knightConfig = useMemo(() => buildKnightConfigFromFleet(knights), [knights])
  
  // Set default knight once fleet loads
  useEffect(() => {
    if (knights.length > 0 && !selectedKnight) {
      setSelectedKnight(knights[0].name)
    }
  }, [knights, selectedKnight])

  const config = selectedKnight ? knightConfig[selectedKnight] : null
  
  // Filter knights by search query
  const filteredKnights = useMemo(() => {
    if (!knightSearchQuery) return knights
    const q = knightSearchQuery.toLowerCase()
    return knights.filter(k => 
      k.name.toLowerCase().includes(q) || 
      k.domain.toLowerCase().includes(q)
    )
  }, [knights, knightSearchQuery])

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
    fetchWithTimeout(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=history`)
      .then(r => (r && r.ok ? r.json() : null))
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
          const probe = await fetchWithTimeout(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=stats&pod=${encodeURIComponent(target.pod)}`)
          const gone = await podGoneFrom(probe, target.pod)
          if (cancelled) return
          if (gone) setPodGone(gone)
          else if (!probe || !probe.ok) setLinkNotice(`Could not reach pod ${target.pod} to check; showing the live session.`)
          else setLinkNotice(`No session found for pod ${target.pod}${target.runId ? ` in run ${target.runId}` : ''}; showing the live session.`)
        }
      })
      .catch(() => { if (!cancelled) setSessions([]) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKnight, linkKey])

  const fetchData = useCallback(async () => {
    if (!selectedKnight) return

    setLoading(true)
    setError(null)

    try {
      // Stats reflect the live session only.
      if (!isArchived) {
        fetchWithTimeout(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=stats`)
          .then(r => r && r.ok ? r.json() : null)
          .then(d => {
            if (d) {
              setStats({ ...d, supported: true })
            } else {
              setStats({ knight: selectedKnight, supported: false, session: null, runtime: { uptime: 0, activeTasks: 0, model: '' } })
            }
          })
          .catch(() => {
            setStats({ knight: selectedKnight, supported: false, session: null, runtime: { uptime: 0, activeTasks: 0, model: '' } })
          })
      }

      // Archived session: replay its persisted entries (timeline/tools views).
      if (isArchived) {
        const res = await fetchWithTimeout(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=session&${sessionQuery(selectedSession)}&limit=300`)
        const gone = await podGoneFrom(res, sessionPod(selectedSession))
        if (gone) {
          setPodGone(gone)
          setEntries([])
          setArchivedMeta(null)
          return
        }
        setPodGone(null)
        if (!res || !res.ok) {
          setEntries([])
          setArchivedMeta(null)
          return
        }
        const data = await res.json()
        setEntries(data.entries || [])
        setTreeNodes([])
        setArchivedMeta({ total: data.total ?? 0, hasMore: !!data.hasMore, startedAt: data.startedAt ?? null })
        return
      }

      if (view === 'tree') {
        const res = await fetchWithTimeout(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=tree`)
        if (!res || !res.ok) {
          setTreeNodes([])
          return
        }
        const data = await res.json()
        setTreeNodes(data.nodes || [])
      } else {
        const res = await fetchWithTimeout(`/api/fleet/${encodeURIComponent(selectedKnight)}/session?type=recent&limit=100`)
        if (!res || !res.ok) {
          setEntries([])
          return
        }
        const data = await res.json()
        setEntries(data.entries || [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to fetch session data')
    } finally {
      setLoading(false)
    }
  }, [selectedKnight, view, selectedSession, isArchived])

  useEffect(() => { fetchData() }, [fetchData])

  // Fetch fleet-wide stats for performance comparison (#50)
  const fetchFleetPerf = useCallback(async () => {
    setShowFleetPerf(true)
    const results: Record<string, KnightSessionStats> = {}
    await Promise.all(knights.map(async k => {
      try {
        const res = await fetchWithTimeout(`/api/fleet/${encodeURIComponent(k.name)}/session?type=stats`)
        if (res && res.ok) {
          const data = await res.json()
          results[k.name] = { ...data, supported: true }
        }
      } catch {}
    }))
    setAllKnightStats(results)
  }, [knights])

  // Build tree from flat nodes
  const tree = useMemo(() => {
    if (treeNodes.length === 0) return []
    const map = new Map<string, SessionTreeNode & { children: SessionTreeNode[] }>()
    for (const n of treeNodes) map.set(n.id, { ...n, children: [] })
    const roots: (SessionTreeNode & { children: SessionTreeNode[] })[] = []
    for (const n of treeNodes) {
      const node = map.get(n.id)!
      if (n.parentId && map.has(n.parentId)) {
        map.get(n.parentId)!.children.push(node)
      } else {
        roots.push(node)
      }
    }
    return roots
  }, [treeNodes])

  // Filter entries
  const filteredEntries = useMemo(() => {
    let result = entries
    if (view === 'tools') {
      result = result.filter(e => e.type === 'tool_use' || e.type === 'tool_result')
    }
    if (filterType) {
      result = result.filter(e => e.type === filterType)
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter(e =>
        (e.text?.toLowerCase().includes(q)) ||
        (e.toolName?.toLowerCase().includes(q)) ||
        (e.input?.toLowerCase().includes(q)) ||
        (e.output?.toLowerCase().includes(q))
      )
    }
    return result
  }, [entries, view, filterType, searchQuery])

  // Tool call stats
  const toolStats = useMemo(() => {
    const tools = entries.filter(e => e.type === 'tool_use')
    const byName: Record<string, number> = {}
    for (const t of tools) {
      const name = t.toolName || 'unknown'
      byName[name] = (byName[name] || 0) + 1
    }
    return { total: tools.length, byName: Object.entries(byName).sort((a, b) => b[1] - a[1]) }
  }, [entries])

  if (fleetLoading) {
    return (
      <div className="text-center py-12">
        <div className="flex justify-center mb-4"><Spinner /></div>
        <p className="text-gray-400">Loading fleet data...</p>
      </div>
    )
  }

  if (knights.length === 0) {
    return <EmptyState icon={TreePine} title="No knights available in the fleet" />
  }

  return (
    <div>
      <PageHeader icon={TreePine} title="Session Explorer">
        <span className="text-sm text-gray-500 font-normal">({knights.length} knights)</span>
        <RefreshButton onClick={fetchData} loading={loading} />
      </PageHeader>

      {/* Knight picker with search + view tabs */}
      <div className="flex items-center gap-4 mb-6">
        <div className="relative">
          <select aria-label="Knight" value={selectedKnight} onChange={e => setSelectedKnight(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-4 py-2 text-white pr-8 appearance-none min-w-[200px]">
            {filteredKnights.map(k => {
              const kc = knightConfig[k.name]
              const statusIcon = k.status === 'online' ? '🟢' : k.status === 'busy' ? '🟡' : '🔴'
              return <option key={k.name} value={k.name}>{kc?.emoji || '🤖'} {k.name} {statusIcon}</option>
            })}
          </select>
        </div>
        
        <div className="relative flex-1 max-w-xs">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
          <input 
            type="text" 
            value={knightSearchQuery} 
            onChange={e => setKnightSearchQuery(e.target.value)}
            aria-label="Filter knights"
            placeholder="Filter knights by name or domain..."
            className="w-full bg-roundtable-navy border border-roundtable-steel rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500" 
          />
        </div>

        <div className="flex rounded-lg border border-roundtable-steel overflow-hidden">
          {(['timeline', 'tree', 'tools'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-4 py-2 text-sm font-medium transition-colors ${
                view === v ? 'bg-roundtable-gold/20 text-roundtable-gold' : 'bg-roundtable-slate text-gray-400 hover:text-white'
              }`}>
              {v === 'timeline' && <><MessageSquare className="w-4 h-4 inline mr-1.5" />Timeline</>}
              {v === 'tree' && <><TreePine className="w-4 h-4 inline mr-1.5" />Tree</>}
              {v === 'tools' && <><Wrench className="w-4 h-4 inline mr-1.5" />Tools</>}
            </button>
          ))}
        </div>

        {view !== 'tree' && (
          <div className="flex items-center gap-2 flex-1">
            <div className="relative flex-1 max-w-xs">
              <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
              <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                aria-label="Search entries"
                placeholder="Search entries..."
                className="w-full bg-roundtable-navy border border-roundtable-steel rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-gray-500" />
            </div>
            <select aria-label="Filter by entry type" value={filterType} onChange={e => setFilterType(e.target.value)}
              className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-sm text-white">
              <option value="">All Types</option>
              <option value="user">📨 User</option>
              <option value="assistant">🤖 Assistant</option>
              <option value="tool_use">🔧 Tool Use</option>
              <option value="tool_result">📋 Tool Result</option>
              <option value="thinking">🧠 Thinking</option>
            </select>
          </div>
        )}
      </div>

      {/* Session picker: live vs. a past (persisted) session */}
      {sessions.length > 0 && (
        <div className="flex items-center gap-3 mb-4 text-sm">
          <span className="text-gray-500 flex items-center gap-1.5"><History className="w-4 h-4" /> Session</span>
          <select
            value={selectedSession}
            onChange={e => { setPodGone(null); setSelectedSession(e.target.value) }}
            aria-label="Session"
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white max-w-xl flex-1">
            <option value="live">🟢 Live (active session)</option>
            {groupedSessions.flatMap(run => run.pods.map(pg => (
              <optgroup key={`${run.runId ?? ''}|${pg.pod ?? ''}`} label={groupLabel(run.runId, pg.pod)}>
                {pg.sessions.map(s => (
                  <option key={sessionHistoryKey(s)} value={sessionHistoryKey(s)}>{sessionLabel(s)}</option>
                ))}
              </optgroup>
            )))}
          </select>
          {isArchived && (
            <span className="text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 whitespace-nowrap">
              📼 Archived
            </span>
          )}
        </div>
      )}

      {linkNotice && !podGone && (
        <div role="status" className="mb-4 rounded-lg border border-yellow-500/40 bg-yellow-900/30 px-4 py-3 text-sm text-yellow-300">{linkNotice}</div>
      )}
      {podGone && <PodGoneNotice pod={podGone} onBack={() => { setPodGone(null); setSelectedSession('live') }} />}

      {/* Archived session banner (replaces live stats when replaying history) */}
      {isArchived && !podGone && (
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-3 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="text-gray-300 font-medium">📼 Replaying archived session</span>
          {archivedMeta?.startedAt && (
            <span className="text-gray-500">Started {formatDateTime(archivedMeta.startedAt)}</span>
          )}
          {archivedMeta && (
            <span className="text-gray-500">{formatNumber(archivedMeta.total)} entries{archivedMeta.hasMore ? ' (showing first 300)' : ''}</span>
          )}
          <button onClick={() => setSelectedSession('live')} className="text-roundtable-gold hover:underline ml-auto">
            ← Back to live
          </button>
        </div>
      )}

      {/* Knight stats bar (live session only) */}
      {!isArchived && stats?.supported === false && (
        <div className="bg-amber-900/20 border border-amber-500/30 rounded-lg p-4 mb-4">
          <p className="text-amber-400 text-sm flex items-center gap-2">
            ℹ️ This knight does not support session introspection. Basic fleet info shown instead.
          </p>
          {config && (
            <div className="mt-2 text-xs text-gray-400">
              <span className="font-medium">{config.emoji} {selectedKnight}</span> · 
              <span className="ml-2">Domain: {knights.find(k => k.name === selectedKnight)?.domain || 'unknown'}</span> · 
              <span className="ml-2">Status: {knights.find(k => k.name === selectedKnight)?.status || 'unknown'}</span>
            </div>
          )}
        </div>
      )}
      {!isArchived && stats?.session && stats.supported !== false && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <StatCard label="Messages" value={stats.session.totalMessages} />
          <StatCard label="Tool Calls" value={stats.session.toolCalls} color="text-purple-400" />
          <StatCard label="Tokens" value={formatNumber(stats.session.tokens.total)} />
          <StatCard label="Cost" value={formatCost(stats.session.cost)} color="text-roundtable-gold" />
          <div className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-3 flex items-center justify-center">
            <button onClick={fetchFleetPerf}
              className="text-xs text-gray-400 hover:text-roundtable-gold flex items-center gap-1">
              <BarChart3 className="w-4 h-4" /> Fleet Comparison
            </button>
          </div>
        </div>
      )}
      {!isArchived && stats?.session && stats.supported !== false && (stats.pods?.length ?? 0) > 1 && (
        <div className="flex flex-wrap items-center gap-2 mb-4 text-xs" aria-label="Per-pod breakdown">
          <span className="text-gray-500">
            Totals across {stats.respondedPods ?? stats.pods!.length}/{stats.podCount ?? stats.pods!.length} pods:
          </span>
          {stats.pods!.map(p => (
            <span key={p.pod} className={`px-2 py-1 rounded-full border ${p.ok ? 'border-roundtable-steel text-gray-300' : 'border-red-500/30 text-red-400'}`}>
              <span className="font-mono">{p.pod}</span>
              {p.ok
                ? ` · ${p.stats?.session?.totalMessages ?? 0} msgs · ${formatCost(p.stats?.session?.cost ?? 0)} · ${p.stats?.runtime?.activeTasks ?? 0} active`
                : ` · ${p.error || 'no reply'}`}
            </span>
          ))}
        </div>
      )}

      {/* Fleet performance comparison (#50) */}
      {showFleetPerf && Object.keys(allKnightStats).length > 0 && (
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3">📊 Fleet Performance Comparison</h3>
          <div className="space-y-2">
            {Object.entries(allKnightStats)
              .filter(([, s]) => s.session)
              .sort((a, b) => (b[1].session?.cost || 0) - (a[1].session?.cost || 0))
              .map(([name, s]) => {
                const cfg = getKnightConfig(name)
                const maxCost = Math.max(...Object.values(allKnightStats).map(s => s.session?.cost || 0))
                const barWidth = maxCost > 0 ? ((s.session?.cost || 0) / maxCost * 100) : 0
                return (
                  <div key={name} className="flex items-center gap-3">
                    <span className="w-24 text-xs text-gray-300 truncate">{cfg.emoji} {name}</span>
                    <div className="flex-1 relative">
                      <ProgressBar percent={barWidth} fillClass="bg-roundtable-gold/30" heightClass="h-5" />
                      <span className="absolute right-2 top-0.5 text-[10px] text-gray-400">
                        {formatCost(s.session?.cost || 0)} · {s.session?.toolCalls || 0} tools · {formatNumber(s.session?.tokens.total || 0)} tokens
                      </span>
                    </div>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4">
          <ErrorBanner>⚠️ {error}</ErrorBanner>
        </div>
      )}

      {loading && (
        <div className="text-center py-12">
          <div className="flex justify-center mb-4"><Spinner /></div>
          <p className="text-gray-400">Querying {config?.emoji} {selectedKnight}...</p>
        </div>
      )}

      {/* Tool Stats bar (tools view) */}
      {view === 'tools' && !loading && toolStats.total > 0 && (
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4 mb-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2">Tool Usage ({toolStats.total} calls)</h3>
          <div className="flex flex-wrap gap-2">
            {toolStats.byName.slice(0, 10).map(([name, count]) => (
              <span key={name} className="text-xs bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-1 rounded-full font-mono">
                {name} <span className="text-gray-500">×{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Tree view */}
      {view === 'tree' && !loading && !podGone && (
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4">
          {tree.length === 0 ? (
            <EmptyState
              icon={TreePine}
              title={isArchived
                ? 'Tree view is available for the live session. Use Timeline or Tools to replay this archived session.'
                : stats?.supported === false
                  ? 'Session introspection not available for this knight.'
                  : 'No session tree data. Dispatch a task to see activity.'}
            />
          ) : (
            <div className="max-h-[70vh] overflow-auto">
              {tree.map(node => (
                <TreeNodeView key={node.id} node={node} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Timeline / Tools view */}
      {view !== 'tree' && !loading && !podGone && (
        <div className="space-y-2">
          {filteredEntries.length === 0 && (
            <EmptyState
              icon={MessageSquare}
              title={!isArchived && stats?.supported === false
                ? 'Session introspection not available for this knight.'
                : searchQuery || filterType
                  ? 'No entries match your filters.'
                  : isArchived
                    ? 'This archived session has no entries.'
                    : 'No session entries found. Dispatch a task to see activity.'}
            />
          )}
          {filteredEntries.map(entry => (
            <ToolCallCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
