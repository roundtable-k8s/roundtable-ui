import { useState, useMemo, useEffect } from 'react'
import { Zap, Crown, DollarSign, TrendingUp, ShieldOff } from 'lucide-react'
import { useTableFilter } from '../hooks/useTableFilter'
import { useFleet } from '../hooks/useFleet'
import type { Knight } from '../hooks/useFleet'
import { KnightCard } from '../components/KnightCard'
import { KnightDetailDrawer } from '../components/KnightDetailDrawer'
import { useWebSocket } from '../hooks/useWebSocket'
import { getKnightConfig } from '../lib/knights'
import { parseEvent, resultFailureReason } from '../lib/events'
import { computeKnightActivity } from '../lib/knightActivity'
import { PageHeader, RefreshButton, StatCard, ErrorBanner, Spinner } from '../components/ui'
import { formatCost, formatTimestamp } from '../lib/format'
import { useCards } from '../hooks/useCards'
import { SkillFilter } from '../components/SkillFilter'
import { isNotIsolated } from '../lib/isolation'
import { cardForKnight, cardSkillTags, matchesSkillFilter, type SkillFilter as SkillFilterValue } from '../lib/cards'

/** The knight's table for card lookup; undefined when unset or "none". */
const tableOf = (k: { table?: string }) => (k.table && k.table !== 'none' ? k.table : undefined)

const knightKey = (k: { namespace?: string; name: string }) => `${k.namespace ?? ''}/${k.name}`

export function FleetPage() {
  const { knights, loading, error, refresh } = useFleet()
  const { table } = useTableFilter()
  // Keep the selection as a key and derive the object from the latest poll so
  // the open drawer follows the live fleet entry.
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selectedKnight = useMemo(
    () => (selectedKey ? knights.find((k) => knightKey(k) === selectedKey) ?? null : null),
    [knights, selectedKey],
  )
  // The selected knight vanished from the fleet: close the drawer.
  useEffect(() => {
    if (selectedKey && !loading && !selectedKnight) setSelectedKey(null)
  }, [selectedKey, selectedKnight, loading])
  const { events } = useWebSocket()
  const { cards } = useCards()
  const [skillFilter, setSkillFilter] = useState<SkillFilterValue>({})
  const [notIsolatedOnly, setNotIsolatedOnly] = useState(false)
  const skillTags = useMemo(() => cardSkillTags(cards.values()), [cards])
  const hasIsolation = knights.some((k) => k.isolation)
  const notIsolatedCount = knights.filter(isNotIsolated).length
  const visibleKnights = useMemo(
    () => knights
      .filter((k) => matchesSkillFilter(cardForKnight(cards, k.name, tableOf(k)), skillFilter))
      .filter((k) => !notIsolatedOnly || isNotIsolated(k))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [knights, cards, skillFilter, notIsolatedOnly],
  )

  const knightActivity = useMemo(() => computeKnightActivity(events, Date.now()), [events])

  // Aggregate costs from result events (#40)
  const costStats = useMemo(() => {
    let totalCost = 0
    let taskCount = 0
    const perKnight: Record<string, number> = {}

    for (const event of events) {
      if (event.type !== 'result') continue
      const { knight, data } = parseEvent(event)
      const cost = typeof data.cost === 'number' ? data.cost : 0
      if (cost > 0) {
        totalCost += cost
        taskCount++
        if (knight) perKnight[knight] = (perKnight[knight] || 0) + cost
      }
    }
    const topSpender = Object.entries(perKnight).sort((a, b) => b[1] - a[1])[0]
    return { totalCost, taskCount, topSpender }
  }, [events])

  const online = knights.filter((k) => k.status === 'online').length
  const total = knights.length

  return (
    <div>
      {/* Header */}
      <PageHeader
        icon={Crown}
        title="The Round Table"
        subtitle={`${online}/${total} knights seated • observing the realm`}
      >
        <RefreshButton onClick={refresh} loading={loading} />
      </PageHeader>

      {/* Summary bar */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-4 mb-8">
        <StatCard
          label="Online"
          value={online}
          total={total}
          color="text-green-400"
          icon={<Zap className="w-5 h-5" />}
        />
        <StatCard
          label="Offline"
          value={knights.filter((k) => k.status === 'offline').length}
          total={total}
          color="text-red-400"
        />
        <StatCard
          label="Restarts"
          value={knights.reduce((sum, k) => sum + k.restarts, 0)}
          color="text-yellow-400"
        />
        <StatCard
          label="Domains"
          value={new Set(knights.map((k) => k.domain)).size}
          color="text-blue-400"
        />
        <StatCard
          label="Session Cost"
          value={costStats.totalCost > 0 ? formatCost(costStats.totalCost) : '$0.00'}
          color="text-roundtable-gold"
          icon={<DollarSign className="w-5 h-5" />}
        />
        <StatCard
          label="Tasks"
          value={costStats.taskCount}
          color="text-purple-400"
          icon={<TrendingUp className="w-5 h-5" />}
        />
      </div>

      {/* Error state */}
      {error && (
        <div className="mb-6">
          <ErrorBanner>
            <p>⚠️ {error}</p>
            <p className="text-red-400/60 text-sm mt-1">API may not be running. Start with: cd api && go run .</p>
          </ErrorBanner>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="text-center py-20">
          <div className="flex justify-center mb-4">
            <Spinner />
          </div>
          <p className="text-gray-400">Summoning knights to the table...</p>
        </div>
      )}

      {/* Error War Room (#45) */}
      {(() => {
        const errors = events
          .filter(e => e.type === 'result' && parseEvent(e).data.success === false)
          .slice(0, 5)

        if (errors.length === 0) return null

        return (
          <div className="bg-red-900/10 border border-red-500/20 rounded-xl p-4 mb-6">
            <h3 className="text-sm font-medium text-red-400 mb-3">⚠️ Recent Failures ({errors.length})</h3>
            <div className="space-y-2">
              {errors.map((e, i) => {
                const { knight, data } = parseEvent(e)
                const cfg = knight ? getKnightConfig(knight) : null
                return (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span>{cfg?.emoji || '🤖'}</span>
                    <span className="text-gray-300 capitalize">{knight || 'unknown'}</span>
                    <span className="text-red-400 truncate flex-1">{resultFailureReason(data) || 'Task failed'}</span>
                    <span className="text-gray-600 flex-shrink-0">{formatTimestamp(e.timestamp)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })()}

      {/* Skill filter (#243): only when the API serves cards */}
      {!loading && cards.size > 0 && (
        <SkillFilter
          tags={skillTags}
          value={skillFilter}
          onChange={setSkillFilter}
          shown={visibleKnights.length}
          total={knights.length}
        />
      )}

      {/* Isolation filter (#269): only when the API reports isolation */}
      {!loading && hasIsolation && (
        <div className="flex items-center gap-2 mb-4">
          <button
            type="button"
            aria-pressed={notIsolatedOnly}
            onClick={() => setNotIsolatedOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors ${
              notIsolatedOnly
                ? 'bg-red-500/20 text-red-300 border-red-500/40'
                : notIsolatedCount > 0
                  ? 'bg-roundtable-slate text-red-300 border-red-500/30 hover:border-red-500/50'
                  : 'bg-roundtable-slate text-gray-400 border-roundtable-steel hover:border-roundtable-gold/30'
            }`}
          >
            <ShieldOff className="w-3.5 h-3.5" aria-hidden />
            Not isolated ({notIsolatedCount})
          </button>
        </div>
      )}

      {/* Knight grid */}
      {!loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {visibleKnights.map((knight) => (
            <KnightCard
              key={knight.name}
              knight={knight}
              onClick={() => setSelectedKey(knightKey(knight))}
              activity={knightActivity[knight.name]}
              card={cardForKnight(cards, knight.name, tableOf(knight))}
              showTable={!table}
            />
          ))}
        </div>
      )}
      {!loading && knights.length > 0 && visibleKnights.length === 0 && (
        <p className="text-center text-gray-500 text-sm py-10">
          {notIsolatedOnly ? 'No knight matches these filters.' : 'No knight has a skill matching this filter.'}
        </p>
      )}

      {/* Knight detail drawer */}
      <KnightDetailDrawer
        knight={selectedKnight}
        onClose={() => setSelectedKey(null)}
        card={selectedKnight ? cardForKnight(cards, selectedKnight.name, tableOf(selectedKnight)) : undefined}
      />
    </div>
  )
}
