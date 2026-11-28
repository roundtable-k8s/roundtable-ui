import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { X, Activity, MessageSquare, Clock, RefreshCw, Terminal, ChevronDown, Cpu, AlertTriangle } from 'lucide-react'
import { getKnightConfig } from '../lib/knights'
import { useKnightSession } from '../hooks/useKnightSession'
import { PodsPanel } from './PodsPanel'
import { KnightEventsPanel } from './KnightEventsPanel'
import { Drawer, Spinner, ErrorBanner } from './ui'
import type { Knight } from '../hooks/useFleet'
import { sanitizeText } from '../lib/untrusted'
import { KnightRecentWork } from './KnightRecentWork'
import { PodLogsViewer } from './PodLogsViewer'
import type { CardEntry } from '../lib/cards'
import { KnightCardSection, KnightIsolationSection } from './knight-drawer/CardSections'
import { useKnightDetail } from './knight-drawer/useKnightDetail'
import { StatusBar } from './knight-drawer/StatusBar'
import { ConfigurationSection } from './knight-drawer/ConfigurationSection'
import { PerformanceSection } from './knight-drawer/PerformanceSection'
import { SkillsSection } from './knight-drawer/SkillsSection'
import { ConditionsSection } from './knight-drawer/ConditionsSection'
import { SnapshotsSection } from './knight-drawer/SnapshotsSection'
import { GeneratedSkillsSection } from './knight-drawer/GeneratedSkillsSection'
import { SessionStatsSection } from './knight-drawer/SessionStatsSection'
import { RuntimeSection } from './knight-drawer/RuntimeSection'
import { RecentActivitySection } from './knight-drawer/RecentActivitySection'

export { KnightCardSection, KnightIsolationSection }

interface Props {
  knight: Knight | null
  onClose: () => void
  /** The knight's agent card (#243); absent → no Card section. */
  card?: CardEntry
}

export function KnightDetailDrawer({ knight, onClose, card }: Props) {
  const { stats, recent, loading, error, fetchStats, fetchRecent, reset: resetSession } = useKnightSession()
  const [recentLoading, setRecentLoading] = useState(false)
  const [logsExpanded, setLogsExpanded] = useState(false)
  // Latest recent-activity request: a superseded refresh must not clear the spinner.
  const recentSeq = useRef(0)
  const knightName = knight?.name
  const knightNamespace = knight?.namespace
  const { detail: knightDetail, loading: detailLoading, error: detailError, refresh: refreshDetail, replace: replaceDetail } =
    useKnightDetail(knightName, knightNamespace)

  const refreshSession = async (name: string) => {
    fetchStats(name)
    const seq = ++recentSeq.current
    setRecentLoading(true)
    await fetchRecent(name, 30)
    if (seq === recentSeq.current) setRecentLoading(false)
  }

  useEffect(() => {
    if (knightName) {
      resetSession()
      refreshSession(knightName)
      setLogsExpanded(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knightName, knightNamespace])

  if (!knight) return null

  const config = getKnightConfig(knight.name)
  const skills = knightDetail?.skillsList ?? knight.skillsList ?? []
  const isolation = knightDetail?.isolation ?? knight.isolation
  const refreshAll = () => { refreshDetail(); refreshSession(knight.name) }

  return (
    <Drawer onClose={onClose} label={`${knight.name} details`} widthClass="w-full max-w-[520px]">
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
            <button onClick={() => refreshAll()} className="text-gray-400 hover:text-roundtable-gold p-1 transition-colors" title="Refresh" aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white p-1">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-4 space-y-6">
          <StatusBar knight={knight} />
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

          {detailError && !knightDetail && (
            <ErrorBanner>
              <p>Could not load the knight&apos;s details: {sanitizeText(detailError)}</p>
              <button
                type="button"
                onClick={() => refreshDetail()}
                className="mt-2 text-xs text-red-300 underline hover:text-white"
              >
                Retry
              </button>
            </ErrorBanner>
          )}

          {detailLoading && !knightDetail && !detailError && (
            <p className="text-gray-500 text-xs" role="status">Loading details...</p>
          )}

          {/* Agent card (#243) */}
          {card && <KnightCardSection entry={card} fallbackMax={knightDetail?.concurrency ?? knight.concurrency} />}

          {/* Recent tasks and schedules (#510) */}
          <KnightRecentWork knight={knight.name} table={knight.table} />

          {/* Isolation (#269) */}
          {isolation && <KnightIsolationSection isolation={isolation} />}

          {knightDetail && (knightDetail.model || knightDetail.runtime || knightDetail.concurrency != null || knightDetail.taskTimeoutSeconds || knightDetail.suspend) && (
            <ConfigurationSection knightDetail={knightDetail} />
          )}

          {knightDetail && (knightDetail.tasksCompleted != null || knightDetail.tasksFailed != null || knightDetail.totalCost) && (
            <PerformanceSection knightDetail={knightDetail} />
          )}

          {skills.length > 0 && <SkillsSection skills={skills} />}

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

          {knightDetail?.conditions && knightDetail.conditions.length > 0 && <ConditionsSection conditions={knightDetail.conditions} />}

          {knightDetail && <SnapshotsSection knight={knight} knightDetail={knightDetail} onDetail={replaceDetail} />}

          {knightDetail?.generatedSkills && knightDetail.generatedSkills.length > 0 && <GeneratedSkillsSection generatedSkills={knightDetail.generatedSkills} />}

          {stats?.session && <SessionStatsSection session={stats.session} />}

          {stats?.runtime && <RuntimeSection runtime={stats.runtime} />}

          {/* Pod Logs Viewer */}
          <div>
            <button
              onClick={() => setLogsExpanded(!logsExpanded)}
              aria-expanded={logsExpanded}
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


          {(recent.length > 0 || recentLoading || stats?.session) && (
            <RecentActivitySection recent={recent} recentLoading={recentLoading} />
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
