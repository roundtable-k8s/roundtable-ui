import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { X, Activity, Cpu, DollarSign, MessageSquare, Wrench, Clock, ChevronRight, RefreshCw, FileCode, Terminal, ChevronDown, Settings, BarChart2, Tag, IdCard, Shield, AlertTriangle, Copy, Check, Camera } from 'lucide-react'
import { getKnightConfig } from '../lib/knights'
import { useKnightSession } from '../hooks/useKnightSession'
import { apiGet } from '../lib/api'
import { formatAge, formatCost, formatUptime, formatTimestamp, formatNumber } from '../lib/format'
import { SnapshotButton } from './SnapshotButton'
import { PodsPanel } from './PodsPanel'
import { KnightEventsPanel } from './KnightEventsPanel'
import { Drawer, StatCard, Spinner, ErrorBanner } from './ui'
import type { Knight, KnightCondition, KnightIsolation } from '../hooks/useFleet'
import { IsolationBadge } from './IsolationBadge'
import { egressHostLabels, optOutSummary } from '../lib/isolation'
import { sanitizeText } from '../lib/untrusted'
import { KnightRecentWork } from './KnightRecentWork'
import { PodLogsViewer } from './PodLogsViewer'
import { cardLoad, type CardEntry } from '../lib/cards'

interface Props {
  knight: Knight | null
  onClose: () => void
  /** The knight's agent card (#243); absent → no Card section. */
  card?: CardEntry
}

function CardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-sm items-start">
      <span className="text-gray-400 flex-shrink-0">{label}</span>
      <span className="text-right min-w-0">{children}</span>
    </div>
  )
}

/** "Card" section: the knight's agent card, live state and load. */
export function KnightCardSection({ entry, fallbackMax }: { entry: CardEntry; fallbackMax?: number }) {
  const { card, live } = entry
  const rt = card.roundtable
  const load = cardLoad(entry, fallbackMax)
  const state = rt.suspended ? 'Suspended' : live ? 'Live' : 'Not live'
  const stateClass = rt.suspended
    ? 'bg-red-500/10 text-red-400 border-red-500/20'
    : live
      ? 'bg-green-500/10 text-green-400 border-green-500/20'
      : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
  return (
    <div data-testid="knight-card-section">
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <IdCard className="w-4 h-4" />
        Card
      </h3>
      <div className="bg-roundtable-slate rounded-lg p-3 space-y-2">
        {card.description && <p className="text-sm text-gray-300">{sanitizeText(card.description)}</p>}
        <CardRow label="State">
          <span className={`text-xs px-2 py-0.5 rounded-full border ${stateClass}`}>{state}</span>
        </CardRow>
        <CardRow label="Load">
          <span className="text-gray-200 font-mono text-xs">
            {load ? `${load.active} / ${load.max ?? '?'} active` : '—'}
          </span>
        </CardRow>
        {rt.model && (
          <CardRow label="Model">
            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono break-all">{sanitizeText(rt.model)}</span>
          </CardRow>
        )}
        {rt.taskSubject && (
          <CardRow label="Task subject">
            <span className="text-xs text-gray-300 font-mono break-all">{sanitizeText(rt.taskSubject)}</span>
          </CardRow>
        )}
        {rt.tools && rt.tools.length > 0 && (
          <CardRow label="Tools">
            <span className="flex flex-wrap justify-end gap-1">
              {rt.tools.map((t) => (
                <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-roundtable-navy/70 border border-roundtable-steel/50 text-gray-300 font-mono">{sanitizeText(t)}</span>
              ))}
            </span>
          </CardRow>
        )}
      </div>
      {card.skills.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-gray-500">Skills ({card.skills.length})</p>
          {card.skills.map((skill) => (
            <div key={skill.id ?? skill.name} className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-medium text-gray-200 font-mono">{sanitizeText(skill.name)}</span>
                {skill.tags && skill.tags.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {skill.tags.map((tag) => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/20">{sanitizeText(tag)}</span>
                    ))}
                  </span>
                )}
              </div>
              {skill.description && <p className="text-xs text-gray-400 mt-1">{sanitizeText(skill.description)}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-roundtable-navy/70 border border-roundtable-steel/50 text-gray-300 font-mono break-all">{children}</span>
  )
}

/** Why hostname rules are not enforced, or null when they are (#269). */
function hostnameWarning(iso: KnightIsolation): string | null {
  if (iso.egressOptOut) return 'No egress policy: this knight may reach any host on any port.'
  if (iso.hostnameRulesEnforced) return null
  const er = iso.egressRestricted
  if (er?.reason === 'FQDNPolicyUnavailable') {
    return 'Hostname rules are not enforced: the CiliumNetworkPolicy API is unavailable, so the allowed ports are open to any destination.'
  }
  if (!er) return 'Hostname rules are not enforced: no egress policy applies to this knight.'
  return `Hostname rules are not enforced (${sanitizeText(er.reason)})${er.message ? `: ${sanitizeText(er.message)}` : ''}`
}

/** "Isolation" section: RuntimeClass, opt-out reason and egress allowlist (#269). */
export function KnightIsolationSection({ isolation: iso }: { isolation: KnightIsolation }) {
  const optedOut = iso.state === 'opted-out'
  const warning = hostnameWarning(iso)
  const egress = iso.egress
  const missingService = iso.egressRestricted?.reason === 'ServiceNotFound'
  const optOuts = optOutSummary(iso)
  return (
    <div data-testid="knight-isolation-section">
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <Shield className="w-4 h-4" />
        Isolation
      </h3>
      <div className={`bg-roundtable-slate rounded-lg p-3 space-y-2 ${optedOut ? 'border border-red-500/40' : ''}`}>
        <CardRow label="State"><IsolationBadge isolation={iso} /></CardRow>
        {optedOut && (
          <div className="text-xs bg-red-500/10 border border-red-500/30 rounded p-2 text-red-300">
            <p className="font-medium">Opted out{optOuts ? ` (${optOuts})` : ''}</p>
            <p className="mt-1">Reason: {sanitizeText(iso.optOutReason || iso.message || 'none given')}</p>
          </div>
        )}
        {iso.state === 'not-enforced' && (
          <div className="text-xs bg-amber-500/10 border border-amber-500/30 rounded p-2 text-amber-300">
            Not enforced{iso.reason ? ` (${sanitizeText(iso.reason)})` : ''}{iso.message ? `: ${sanitizeText(iso.message)}` : ''}
          </div>
        )}
        <CardRow label="RuntimeClass">
          {iso.runtimeClassName
            ? <Chip>{sanitizeText(iso.runtimeClassName)}</Chip>
            : <span className="text-xs text-gray-500">{iso.runtimeOptOut ? 'none (cluster default runtime)' : 'not reported'}</span>}
        </CardRow>
        {warning && (
          <p data-testid="hostname-warning" className="text-xs text-amber-300 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden />
            {warning}
          </p>
        )}
        {missingService && iso.egressRestricted?.message && (
          <p className="text-xs text-amber-300">{sanitizeText(iso.egressRestricted.message)}</p>
        )}
        {egress && (() => {
          const hostLabels = egressHostLabels(egress)
          return (
          <>
            <CardRow label="Allowed hosts">
              {hostLabels.length > 0
                ? <span className="flex flex-wrap justify-end gap-1">{hostLabels.map((h, i) => <Chip key={`${i}-${h}`}>{sanitizeText(h)}</Chip>)}</span>
                : <span className="text-xs text-gray-500">none (DNS, NATS and the baseline only)</span>}
            </CardRow>
            <CardRow label="Allowed ports">
              {egress.allowedPorts.length > 0
                ? <span className="flex flex-wrap justify-end gap-1">{egress.allowedPorts.map((p) => <Chip key={p}>{p}</Chip>)}</span>
                : <span className="text-xs text-gray-500">—</span>}
            </CardRow>
            <CardRow label="Allowed services">
              {egress.allowedServices.length > 0
                ? (
                  <span className="flex flex-wrap justify-end gap-1">
                    {egress.allowedServices.map((svc) => {
                      const label = `${svc.namespace ? `${svc.namespace}/` : ''}${svc.name}:${svc.ports.join(',')}`
                      return <Chip key={label}>{sanitizeText(label)}</Chip>
                    })}
                  </span>
                )
                : <span className="text-xs text-gray-500">none</span>}
            </CardRow>
            {egress.source === 'table' && <p className="text-[11px] text-gray-500">Allowlist inherited from the RoundTable default.</p>}
            {egress.source === 'default' && <p className="text-[11px] text-gray-500">No allowlist set: the operator default applies.</p>}
          </>
          )
        })()}
      </div>
    </div>
  )
}

const entryTypeColors: Record<string, string> = {
  user: 'bg-blue-500/20 text-blue-400',
  assistant: 'bg-green-500/20 text-green-400',
  tool_use: 'bg-purple-500/20 text-purple-400',
  tool_result: 'bg-amber-500/20 text-amber-400',
  thinking: 'bg-gray-500/20 text-gray-400',
  compaction: 'bg-red-500/20 text-red-400',
}

function statusLabel(k: Knight): string {
  switch (k.status) {
    case 'scaled-to-zero': return 'Scaled to zero'
    case 'starting': return 'Starting'
    case 'busy': return 'Busy'
    case 'online': return 'Online'
    case 'offline': return 'Offline'
    default: return k.ready ? 'Online' : 'Offline'
  }
}

export function KnightDetailDrawer({ knight, onClose, card }: Props) {
  const { stats, recent, loading, error, fetchStats, fetchRecent, reset: resetSession } = useKnightSession()
  const [recentLoading, setRecentLoading] = useState(false)
  const [logsExpanded, setLogsExpanded] = useState(false)
  const [knightDetail, setKnightDetail] = useState<Knight | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const detailAbort = useRef<AbortController | null>(null)

  const fetchKnightDetail = async (knightName: string) => {
    // One detail request at a time: abort the previous one (other knight or
    // an earlier refresh) so its late response can't be rendered.
    detailAbort.current?.abort()
    const controller = new AbortController()
    detailAbort.current = controller
    setDetailLoading(true)
    try {
      const detail = await apiGet<Knight>(`/api/fleet/${encodeURIComponent(knightName)}`, { signal: controller.signal })
      if (!controller.signal.aborted) setKnightDetail(detail)
    } catch (e) {
      if (!controller.signal.aborted) console.error('Failed to fetch knight detail:', e)
    } finally {
      if (!controller.signal.aborted) setDetailLoading(false)
    }
  }

  const refreshAll = async (knightName: string) => {
    fetchStats(knightName)
    fetchKnightDetail(knightName)
    setRecentLoading(true)
    await fetchRecent(knightName, 30)
    setRecentLoading(false)
  }

  // Keyed on the knight's identity, not the object: the fleet poll hands the
  // drawer a fresh object every 10 s and that must not refetch or reset it.
  const knightName = knight?.name
  const knightNamespace = knight?.namespace
  useEffect(() => {
    if (knightName) {
      // Clear the previous knight's detail so a slow/failed fetch can't show
      // knight A's skills and config under knight B's name
      setKnightDetail(null)
      resetSession()
      refreshAll(knightName)
      setLogsExpanded(false)
    }
    return () => detailAbort.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knightName, knightNamespace])

  if (!knight) return null

  const config = getKnightConfig(knight.name)
  const skills = knightDetail?.skillsList ?? knight.skillsList ?? []

  return (
    <Drawer onClose={onClose} label={`${knight.name} details`} widthClass="w-[520px]">
        {/* Header */}
        <div className="sticky top-0 bg-roundtable-slate border-b border-roundtable-steel p-4 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{config.emoji}</span>
            <div>
              <h2 className="text-xl font-bold text-white capitalize">{knight.name}</h2>
              <p className={`text-sm ${config.color}`}>{config.title} Knight</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/chat?knight=${encodeURIComponent(knight.name)}${knight.namespace ? `&ns=${encodeURIComponent(knight.namespace)}` : ''}`}
              className="inline-flex items-center gap-1 text-xs text-gray-400 hover:text-roundtable-gold px-1 transition-colors"
            >
              <MessageSquare className="w-4 h-4" /> Chat
            </Link>
            <button onClick={() => knight && refreshAll(knight.name)} className="text-gray-400 hover:text-roundtable-gold p-1 transition-colors" title="Refresh" aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white p-1">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-6">
          {/* Status bar */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`w-2.5 h-2.5 rounded-full ${knight.status === 'scaled-to-zero' ? 'bg-gray-500' : knight.status === 'starting' ? 'bg-amber-500' : knight.ready ? 'bg-green-500' : 'bg-red-500'} animate-pulse`} />
            <span className="text-sm text-gray-300">{statusLabel(knight)}</span>
            <span className="text-xs text-gray-500">•</span>
            <span className="text-xs text-gray-500">{formatAge(knight.createdAt, knight.age)} {knight.ready ? 'uptime' : 'age'}</span>
            <span className="text-xs text-gray-500">•</span>
            <span className="text-xs text-gray-500">{knight.restarts} restarts</span>
            <span className="text-xs text-gray-500">•</span>
            <span className="text-xs text-gray-400 font-mono">{knight.name}</span>
          </div>

          {loading && (
            <div className="text-center py-8">
              <div className="flex justify-center mb-2"><Spinner size="sm" /></div>
              <p className="text-gray-500 text-sm">Querying knight...</p>
            </div>
          )}

          {error && (
            <ErrorBanner>
              ⚠️ {error}
              <p className="text-red-400/60 text-xs mt-1">Knight may not have introspection enabled yet</p>
            </ErrorBanner>
          )}

          {/* Agent card (#243) */}
          {card && <KnightCardSection entry={card} fallbackMax={knightDetail?.concurrency ?? knight.concurrency} />}

          {/* Recent tasks and schedules (#510) */}
          <KnightRecentWork knight={knight.name} table={knight.table} />

          {/* Isolation (#269) */}
          {(knightDetail?.isolation ?? knight.isolation) && (
            <KnightIsolationSection isolation={(knightDetail?.isolation ?? knight.isolation)!} />
          )}

          {/* Configuration */}
          {(knightDetail?.model || knightDetail?.runtime || knightDetail?.concurrency != null || knightDetail?.taskTimeoutSeconds || knightDetail?.suspend) && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <Settings className="w-4 h-4" />
                Configuration
              </h3>
              <div className="bg-roundtable-slate rounded-lg p-3 space-y-2">
                {knightDetail.suspend && (
                  <div className="flex justify-between text-sm items-center">
                    <span className="text-gray-400">Status</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/20">Suspended</span>
                  </div>
                )}
                {knightDetail.model && (
                  <div className="flex justify-between text-sm items-center">
                    <span className="text-gray-400">Model</span>
                    <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono">{knightDetail.model}</span>
                  </div>
                )}
                {knightDetail.runtime && (
                  <div className="flex justify-between text-sm items-center">
                    <span className="text-gray-400">Runtime</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${
                      knightDetail.runtime === 'sandbox'
                        ? 'bg-purple-500/10 text-purple-400 border-purple-500/20'
                        : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
                    }`}>{knightDetail.runtime}</span>
                  </div>
                )}
                {knightDetail.concurrency != null && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Concurrency Limit</span>
                    <span className="text-gray-200">{knightDetail.concurrency}</span>
                  </div>
                )}
                {knightDetail.taskTimeoutSeconds && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Task Timeout</span>
                    <span className="text-gray-200">{knightDetail.taskTimeoutSeconds}s</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Performance */}
          {(knightDetail?.tasksCompleted != null || knightDetail?.tasksFailed != null || knightDetail?.totalCost) && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <BarChart2 className="w-4 h-4" />
                Performance
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {knightDetail.tasksCompleted != null && (
                  <StatCard
                    icon={<Activity className="w-4 h-4" />}
                    label="Completed"
                    value={knightDetail.tasksCompleted}
                    color="text-green-400"
                  />
                )}
                {knightDetail.tasksFailed != null && (
                  <StatCard
                    icon={<Activity className="w-4 h-4" />}
                    label="Failed"
                    value={knightDetail.tasksFailed}
                    color="text-red-400"
                  />
                )}
                {knightDetail.totalCost && (
                  <StatCard
                    icon={<DollarSign className="w-4 h-4" />}
                    label="Total Cost"
                    value={`$${knightDetail.totalCost}`}
                    color="text-roundtable-gold"
                  />
                )}
                {knightDetail.tasksCompleted != null && knightDetail.tasksFailed != null && (knightDetail.tasksCompleted + knightDetail.tasksFailed) > 0 && (
                  <StatCard
                    icon={<BarChart2 className="w-4 h-4" />}
                    label="Success Rate"
                    value={`${Math.round((knightDetail.tasksCompleted / (knightDetail.tasksCompleted + knightDetail.tasksFailed)) * 100)}%`}
                    color="text-blue-400"
                  />
                )}
              </div>
            </div>
          )}

          {/* Skills List (from CRD skillsList field) */}
          {skills.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <Tag className="w-4 h-4" />
                Skills ({skills.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                {skills.map((skill, i) => (
                  <span
                    key={skill}
                    className={`inline-flex items-center px-2.5 py-1 rounded-lg text-xs border ${
                      i % 2 === 0
                        ? 'bg-blue-500/10 text-blue-300 border-blue-500/20'
                        : 'bg-purple-500/10 text-purple-300 border-purple-500/20'
                    }`}
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Pods & scaling */}
          {(knightDetail?.pods || knightDetail?.scaling) && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <Cpu className="w-4 h-4" />
                Pods
              </h3>
              <PodsPanel knight={knightDetail} />
            </div>
          )}

          {/* Recent Kubernetes events (#529) */}
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Events
            </h3>
            <KnightEventsPanel knight={knight.name} />
          </div>

          {/* Conditions */}
          {knightDetail?.conditions && knightDetail.conditions.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Conditions
              </h3>
              <div className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-roundtable-steel/50">
                      <th className="text-left text-gray-500 font-medium px-3 py-2">Type</th>
                      <th className="text-left text-gray-500 font-medium px-3 py-2">Status</th>
                      <th className="text-left text-gray-500 font-medium px-3 py-2 hidden sm:table-cell">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {knightDetail.conditions.map((cond: KnightCondition, i: number) => {
                      const statusColor =
                        cond.status === 'True' ? 'text-green-400 bg-green-500/10 border-green-500/20' :
                        cond.status === 'False' ? 'text-red-400 bg-red-500/10 border-red-500/20' :
                        'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
                      return (
                        <tr key={cond.type} className={i < knightDetail.conditions!.length - 1 ? 'border-b border-roundtable-steel/30' : ''}>
                          <td className="px-3 py-2 text-gray-200 font-medium">{cond.type}</td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full border ${statusColor}`}>{cond.status}</span>
                          </td>
                          <td className="px-3 py-2 text-gray-400 font-mono hidden sm:table-cell">{cond.reason || cond.message || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Workspace snapshots (#470) */}
          {knightDetail && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <Camera className="w-4 h-4" />
                Workspace snapshots ({knightDetail.workspaceSnapshots?.length ?? 0})
                {knightDetail.workspaceSnapshotsCondition && (
                  <span className="text-xs text-gray-500 font-normal">
                    WorkspaceSnapshots: {knightDetail.workspaceSnapshotsCondition.status}
                    {knightDetail.workspaceSnapshotsCondition.reason ? ` (${knightDetail.workspaceSnapshotsCondition.reason})` : ''}
                  </span>
                )}
                <span className="ml-auto">
                  <SnapshotButton name={knight.name} namespace={knight.namespace} knight={knightDetail} onDetail={setKnightDetail} />
                </span>
              </h3>
              {(knightDetail.workspaceSnapshots?.length ?? 0) === 0 ? (
                <p className="text-xs text-gray-500 bg-roundtable-slate border border-roundtable-steel/50 rounded-lg px-3 py-2">No snapshots yet</p>
              ) : (<>
              <ul className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg divide-y divide-roundtable-steel/30">
                {knightDetail.workspaceSnapshots!.map((snap) => (
                  <li key={snap.name} className="px-3 py-2 flex items-center gap-2 text-xs">
                    <span className="font-mono text-gray-200 truncate">{sanitizeText(snap.name)}</span>
                    <SnapshotCopyButton name={snap.name} />
                    <span className="ml-auto text-gray-500">{formatAge(snap.createdAt)}</span>
                    <span className={`px-2 py-0.5 rounded-full border ${snap.readyToUse ? 'text-green-400 bg-green-500/10 border-green-500/20' : 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'}`}>
                      {snap.readyToUse ? 'Ready' : 'Pending'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-gray-500 mt-2">
                Fork from one with <code className="font-mono">spec.workspace.fromSnapshot</code>
              </p>
              </>)}
            </div>
          )}

          {/* Generated Skills */}
          {knightDetail?.generatedSkills && knightDetail.generatedSkills.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <FileCode className="w-4 h-4" />
                Generated Skills ({knightDetail.generatedSkills.length})
              </h3>
              <div className="space-y-2">
                {knightDetail.generatedSkills.map((skill) => (
                  <details key={skill.name} className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg">
                    <summary className="px-3 py-2 cursor-pointer text-xs text-gray-300 hover:text-roundtable-gold transition-colors">
                      {skill.name}
                    </summary>
                    <div className="px-3 pb-3">
                      <pre className="text-xs text-gray-400 whitespace-pre-wrap overflow-x-auto max-h-64">
                        {sanitizeText(skill.content)}
                      </pre>
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}

          {/* Session Stats */}
          {stats?.session && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4" />
                Session Stats
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <StatCard
                  icon={<MessageSquare className="w-4 h-4" />}
                  label="Messages"
                  value={stats.session.totalMessages}
                  detail={`${stats.session.userMessages} user / ${stats.session.assistantMessages} assistant`}
                />
                <StatCard
                  icon={<Wrench className="w-4 h-4" />}
                  label="Tool Calls"
                  value={stats.session.toolCalls}
                />
                <StatCard
                  icon={<Cpu className="w-4 h-4" />}
                  label="Tokens"
                  value={formatNumber(stats.session.tokens.total)}
                  detail={`${formatNumber(stats.session.tokens.input)} in / ${formatNumber(stats.session.tokens.output)} out`}
                />
                <StatCard
                  icon={<DollarSign className="w-4 h-4" />}
                  label="Total Cost"
                  value={formatCost(stats.session.cost)}
                  color="text-roundtable-gold"
                />
              </div>
            </div>
          )}

          {/* Runtime Info */}
          {stats?.runtime && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <Cpu className="w-4 h-4" />
                Runtime
              </h3>
              <div className="bg-roundtable-slate rounded-lg p-3 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Model</span>
                  <span className="text-gray-200 font-mono text-xs">{stats.runtime.model}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Uptime</span>
                  <span className="text-gray-200">{formatUptime(stats.runtime.uptime)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-400">Active Tasks</span>
                  <span className={stats.runtime.activeTasks > 0 ? 'text-yellow-400' : 'text-gray-200'}>
                    {stats.runtime.activeTasks}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Pod Logs Viewer */}
          <div>
            <button
              onClick={() => setLogsExpanded(!logsExpanded)}
              className="w-full flex items-center justify-between text-sm font-medium text-gray-400 mb-3 hover:text-roundtable-gold transition-colors"
            >
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4" />
                Pod Logs
              </div>
              <ChevronDown className={`w-4 h-4 transition-transform ${logsExpanded ? 'rotate-180' : ''}`} />
            </button>
            {logsExpanded && (
              <div className="bg-black/50 border border-roundtable-steel rounded-lg p-3">
                <PodLogsViewer knightName={knight.name} />
              </div>
            )}
          </div>

          {/* Recent Activity */}
          {(recent.length > 0 || recentLoading || stats?.session) && (
            <div>
              <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                <Clock className="w-4 h-4" />
                Recent Activity {recent.length > 0 && `(${recent.length} entries)`}
              </h3>
              {recentLoading && (
                <div className="text-center py-4">
                  <div className="flex justify-center mb-2"><Spinner size="sm" /></div>
                  <p className="text-gray-500 text-xs">Loading activity...</p>
                </div>
              )}
              {!recentLoading && recent.length === 0 && (
                <p className="text-gray-500 text-sm text-center py-4">Send a task to see activity here</p>
              )}
              <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
                {recent.map((entry) => (
                  <ActivityEntry key={entry.id} entry={entry} />
                ))}
              </div>
            </div>
          )}

          {/* No session */}
          {!loading && !error && !stats?.session && (
            <div className="text-center py-8 text-gray-500">
              <Activity className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No session data available</p>
              <p className="text-xs mt-1">Knight may not have processed any tasks yet</p>
            </div>
          )}
        </div>
    </Drawer>
  )
}

function ActivityEntry({ entry }: { entry: any }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className="bg-roundtable-slate rounded-lg p-2.5 border border-roundtable-steel/50 cursor-pointer hover:border-roundtable-gold/30 transition-colors"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={`text-xs px-1.5 py-0.5 rounded ${entryTypeColors[entry.type] || 'bg-gray-500/20 text-gray-400'}`}>
            {entry.type === 'tool_use' ? '🔧' : entry.type === 'tool_result' ? '📋' : entry.role === 'user' ? '📨' : '🤖'}
            {' '}{entry.type}
          </span>
          {entry.toolName && (
            <span className="text-xs text-purple-400 font-mono">{entry.toolName}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-600">{formatTimestamp(entry.timestamp)}</span>
          <ChevronRight className={`w-3 h-3 text-gray-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
      </div>
      {entry.text && (
        <p className={`text-xs text-gray-400 mt-1 ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-4'}`}>{sanitizeText(entry.text)}</p>
      )}
      {entry.input && (
        <p className={`text-xs text-gray-500 mt-1 font-mono ${expanded ? 'whitespace-pre-wrap break-all' : 'line-clamp-3'}`}>→ {sanitizeText(entry.input)}</p>
      )}
      {entry.output && (
        <p className={`text-xs text-gray-500 mt-1 font-mono ${expanded ? 'whitespace-pre-wrap break-all' : 'line-clamp-3'}`}>← {sanitizeText(entry.output)}</p>
      )}
      {entry.cost != null && entry.cost > 0 && (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-roundtable-gold">{formatCost(entry.cost)}</span>
          {entry.tokens && (
            <span className="text-xs text-gray-600">{entry.tokens.input + entry.tokens.output} tokens</span>
          )}
        </div>
      )}
    </div>
  )
}

function SnapshotCopyButton({ name }: { name: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={`Copy snapshot name ${name}`}
      className="text-gray-500 hover:text-roundtable-gold"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(name)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch { /* clipboard denied */ }
      }}
    >
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}
