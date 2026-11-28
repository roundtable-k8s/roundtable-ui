import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { TreePine, ServerOff } from 'lucide-react'
import { buildKnightConfigFromFleet } from '../lib/knights'
import { useFleet } from '../hooks/useFleet'
import { Spinner, ErrorBanner, EmptyState, PageHeader, RefreshButton } from '../components/ui'
import { sanitizeText } from '../lib/untrusted'
import { useSessionData } from './sessions/useSessionData'
import { KnightPicker } from './sessions/KnightPicker'
import { SessionPicker, ArchivedBanner } from './sessions/SessionPicker'
import { KnightStatsBar } from './sessions/KnightStatsBar'
import { FleetPerformance, useFleetPerf } from './sessions/FleetPerformance'
import { ToolStatsBar } from './sessions/ToolStatsBar'
import { TreeView, EntryList } from './sessions/EntryViews'

// Re-exported so existing importers (and tests) keep using pages/Sessions.
export { sessionHistoryKey, sessionQuery, sessionPod } from './sessions/helpers'
export { TreeNodeView, ToolCallCard } from './sessions/EntryViews'

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

export function SessionsPage() {
  const { knights, loading: fleetLoading, error: fleetError, refresh: refreshFleet } = useFleet()
  const d = useSessionData(knights)
  const { allKnightStats, showFleetPerf, fetchFleetPerf } = useFleetPerf(knights)
  const [knightSearchQuery, setKnightSearchQuery] = useState('')

  // Build dynamic knight config from fleet
  const knightConfig = useMemo(() => buildKnightConfigFromFleet(knights), [knights])
  const config = d.selectedKnight ? knightConfig[d.selectedKnight] : null

  // Filter knights by search query
  const filteredKnights = useMemo(() => {
    if (!knightSearchQuery) return knights
    const q = knightSearchQuery.toLowerCase()
    return knights.filter(k =>
      k.name.toLowerCase().includes(q) ||
      k.domain.toLowerCase().includes(q)
    )
  }, [knights, knightSearchQuery])

  if (fleetLoading) {
    return (
      <div className="text-center py-12">
        <div className="flex justify-center mb-4"><Spinner /></div>
        <p className="text-gray-400">Loading fleet data...</p>
      </div>
    )
  }

  if (knights.length === 0 && fleetError) {
    return (
      <div className="space-y-3">
        <ErrorBanner>Could not load the fleet: {sanitizeText(fleetError)}</ErrorBanner>
        <button onClick={refreshFleet} className="text-sm underline text-roundtable-gold hover:text-white">Retry</button>
      </div>
    )
  }

  if (knights.length === 0) {
    return <EmptyState icon={TreePine} title="No knights available in the fleet" />
  }

  const backToLive = () => { d.setPodGone(null); d.setSelectedSession('live') }

  return (
    <div>
      <PageHeader icon={TreePine} title="Session Explorer">
        <span className="text-sm text-gray-500 font-normal">({knights.length} knights)</span>
        <RefreshButton onClick={d.fetchData} loading={d.loading} />
      </PageHeader>

      <KnightPicker
        knights={knights} filteredKnights={filteredKnights} knightConfig={knightConfig}
        selectedKnight={d.selectedKnight} onSelectKnight={d.setSelectedKnight}
        knightSearchQuery={knightSearchQuery} onKnightSearchChange={setKnightSearchQuery}
        view={d.view} onViewChange={d.setView}
        searchQuery={d.searchQuery} onSearchChange={d.setSearchQuery}
        filterType={d.filterType} onFilterTypeChange={d.setFilterType}
      />

      <SessionPicker
        sessions={d.sessions} groupedSessions={d.groupedSessions} selectedSession={d.selectedSession}
        onSelectSession={key => { d.setPodGone(null); d.setSelectedSession(key) }} isArchived={d.isArchived}
      />

      {d.linkNotice && !d.podGone && (
        <div role="status" className="mb-4 rounded-lg border border-yellow-500/40 bg-yellow-900/30 px-4 py-3 text-sm text-yellow-300">{d.linkNotice}</div>
      )}
      {d.podGone && <PodGoneNotice pod={d.podGone} onBack={backToLive} />}

      {d.isArchived && !d.podGone && (
        <ArchivedBanner meta={d.archivedMeta} onBack={() => d.setSelectedSession('live')} />
      )}

      {!d.isArchived && (
        <KnightStatsBar stats={d.stats} selectedKnight={d.selectedKnight} knights={knights} config={config} onFleetComparison={fetchFleetPerf} />
      )}

      {showFleetPerf && <FleetPerformance allKnightStats={allKnightStats} />}

      {d.error && (
        <div className="mb-4">
          <ErrorBanner>⚠️ {d.error}</ErrorBanner>
        </div>
      )}

      {d.loading && (
        <div className="text-center py-12">
          <div className="flex justify-center mb-4"><Spinner /></div>
          <p className="text-gray-400">Querying {config?.emoji} {d.selectedKnight}...</p>
        </div>
      )}

      {d.view === 'tools' && !d.loading && <ToolStatsBar toolStats={d.toolStats} />}

      {d.view === 'tree' && !d.loading && !d.podGone && (
        <TreeView tree={d.tree} isArchived={d.isArchived} stats={d.stats} />
      )}

      {d.view !== 'tree' && !d.loading && !d.podGone && (
        <EntryList entries={d.filteredEntries} isArchived={d.isArchived} stats={d.stats} hasFilter={!!(d.searchQuery || d.filterType)} />
      )}
    </div>
  )
}
