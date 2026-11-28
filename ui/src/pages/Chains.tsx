import { apiGet, apiGetWithTotal } from '../lib/api'
import { type KeyedTotal, totalFor, truncationNote } from '../lib/chainTotal'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, Radio, WifiOff } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader, RefreshButton, ErrorBanner, ListState } from '../components/ui'
import { countLabel } from '../lib/format'
import type { Chain, ChainRunGroup } from '../lib/types'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { useWebSocket } from '../hooks/useWebSocket'
import { useTableFilter } from '../hooks/useTableFilter'
import { withTable } from '../lib/tables'
import { applyChainUpdate, parseChainUpdate, sortScheduledFirst, type ChainUpdate } from '../lib/chains'
import { CHAINS_LIST_URL, CHAIN_GROUPS_URL, FALLBACK_POLL_MS, GROUP_REFRESH_MS, chainDetailUrl } from './chains/urls'
import { ChainCard } from './chains/ChainCard'
import { RunGroup } from './chains/RunGroup'
export { FALLBACK_POLL_MS, CHAINS_LIST_URL, CHAIN_GROUPS_URL, GROUP_PAGE_SIZE, GROUP_REFRESH_MS, chainDetailUrl, groupRunsUrl } from './chains/urls'
export { FanOutProgress, LoopRounds } from './chains/StepViews'

export function ChainsPage() {
  // ?chain=<name> deep link (e.g. from the Running page) expands that chain
  const [searchParams] = useSearchParams()
  const focusChain = searchParams.get('chain') || ''
  const { table } = useTableFilter()
  const { connected, subscribeTopic } = useWebSocket()
  const [chains, setChains] = useState<Chain[]>([])
  const [storedTotal, setStoredTotal] = useState<KeyedTotal | null>(null)
  const listTotal = totalFor(storedTotal, withTable(CHAINS_LIST_URL, table))
  const [groups, setGroups] = useState<ChainRunGroup[]>([])
  const focusData = usePolledFetch<Chain | null>(focusChain ? chainDetailUrl(focusChain) : null, 0, null).data
  const focusDetail = focusData?.name ? focusData : null
  const [refreshToken, setRefreshToken] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const abortRef = useRef<AbortController | null>(null)
  // Live updates that arrive while a list fetch is in flight; replayed on
  // top of the (possibly older) snapshot so they aren't lost.
  const pending = useRef<ChainUpdate[] | null>(null)

  const fetchGroups = useCallback(() => {
    apiGet<ChainRunGroup[]>(CHAIN_GROUPS_URL)
      .then(g => setGroups(g || []))
      .catch(() => { /* keep the last known groups */ })
  }, [])

  const fetchChains = useCallback(() => {
    // Abort any in-flight request (#39)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const replay: ChainUpdate[] = []
    pending.current = replay

    setLoading(true)
    setRefreshToken(t => t + 1)
    fetchGroups()
    apiGetWithTotal<Chain[]>(withTable(CHAINS_LIST_URL, table), { signal: controller.signal })
      .then(({ items: data, total }) => {
        if (controller.signal.aborted) return
        setChains(replay.reduce(applyChainUpdate, data || []))
        setError('')
        // X-Total-Count comes with the list; keyed by URL so a table switch can't show the old one.
        setStoredTotal({ url: withTable(CHAINS_LIST_URL, table), total })
      })
      .catch((e) => {
        // Keep the last good list on transient failures — surface the error instead
        if (e.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Failed to load chains')
      })
      .finally(() => {
        if (controller.signal.aborted) return
        if (pending.current === replay) pending.current = null
        setLoading(false)
      })
  }, [fetchGroups, table])

  // A run copy changed: refresh the group counts, coalescing bursts.
  const groupsTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleGroups = useCallback(() => {
    if (groupsTimer.current) return
    groupsTimer.current = setTimeout(() => {
      groupsTimer.current = null
      fetchGroups()
    }, GROUP_REFRESH_MS)
  }, [fetchGroups])
  useEffect(() => () => { if (groupsTimer.current) clearTimeout(groupsTimer.current) }, [])

  // Live `chain` WS messages (add/update/delete of a Chain). Run copies are
  // handled by their RunGroup; here they only refresh the group counts.
  useEffect(() => subscribeTopic('chain', (data, msg) => {
    const u = parseChainUpdate(data, msg)
    if (!u) return
    // Another table's chain: not part of this view.
    if (u.op === 'upsert' && table && u.chain.table && u.chain.table !== table) return
    if (u.op === 'upsert' && u.chain.runTemplate) {
      scheduleGroups()
      return
    }
    if (u.op === 'delete') scheduleGroups()
    pending.current?.push(u)
    setChains(prev => applyChainUpdate(prev, u))
  }), [subscribeTopic, scheduleGroups, table])

  // Fetch on mount and re-sync on every (re)connect, so changes missed
  // while the feed was down are picked up.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current || connected) fetchChains()
    mounted.current = true
  }, [connected, fetchChains])

  // A deep-linked chain may be a run copy (not in the list): fetch it so its
  // group opens with it, or show it on its own.
  // Slow fallback poll only while the live feed is down; paused when hidden (#22)
  useEffect(() => {
    if (connected) return
    let interval: ReturnType<typeof setInterval> | null = null
    const start = () => { if (!interval) interval = setInterval(fetchChains, FALLBACK_POLL_MS) }
    const stop = () => { if (interval) { clearInterval(interval); interval = null } }
    const onVis = () => { document.hidden ? stop() : start() }

    start()
    document.addEventListener('visibilitychange', onVis)
    return () => { stop(); document.removeEventListener('visibilitychange', onVis) }
  }, [connected, fetchChains])

  // Cleanup abort on unmount
  useEffect(() => () => { abortRef.current?.abort() }, [])

  // A focused chain that is neither listed nor a run copy (e.g. just created)
  // is shown first; a focused run copy whose group is not known yet gets one.
  const shownChains = useMemo(() => {
    if (!focusDetail || focusDetail.runTemplate || chains.some(c => c.name === focusDetail.name)) return chains
    return [focusDetail, ...chains]
  }, [chains, focusDetail])
  const sortedChains = useMemo(() => sortScheduledFirst(shownChains), [shownChains])
  const shownGroups = useMemo(() => {
    const t = focusDetail?.runTemplate
    if (!t || groups.some(g => g.template === t)) return groups
    const phase = focusDetail.phase || 'Pending'
    return [{ template: t, runs: 1, phases: { [phase]: 1 }, lastStartTime: focusDetail.startTime, templateExists: chains.some(c => c.name === t) }, ...groups]
  }, [groups, focusDetail, chains])

  return (
    <div>
      <PageHeader icon={Link} title="Chain Executions" subtitle={(loading || error) && chains.length === 0 ? undefined : countLabel(chains.length, listTotal ?? chains.length, 'chains')}>
        {connected ? (
          <span className="flex items-center gap-1.5 text-xs text-green-400">
            <Radio className="w-3 h-3" />
            Live
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs text-yellow-400">
            <WifiOff className="w-3 h-3" />
            Live feed disconnected — polling every {FALLBACK_POLL_MS / 1000}s
          </span>
        )}
        <RefreshButton onClick={fetchChains} loading={loading} />
      </PageHeader>

      {error && shownChains.length + shownGroups.length > 0 && (
        <div className="mb-6">
          <ErrorBanner>Failed to refresh chains: {error} — showing last known state</ErrorBanner>
        </div>
      )}

      {truncationNote(chains.length, listTotal) && (
        <p className="mb-3 text-xs text-yellow-400" data-testid="chains-truncated">
          {truncationNote(chains.length, listTotal)} chains — the rest are not listed or searchable here.
        </p>
      )}

      {shownChains.length === 0 && shownGroups.length === 0 && (
        <ListState loading={loading} error={error} count={0} what="chains" icon={Link}
          emptyTitle="No chain executions found." onRetry={fetchChains} />
      )}

      <div className="space-y-3">
        {sortedChains.map(chain => <ChainCard key={`${chain.namespace}/${chain.name}`} chain={chain} focused={chain.name === focusChain} />)}
      </div>

      {shownGroups.length > 0 && (
        <div className="mt-8">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Runs by template</h2>
          <div className="space-y-3">
            {shownGroups.map(g => (
              <RunGroup key={g.template} group={g} focusChain={focusChain} focusDetail={focusDetail} refreshToken={refreshToken} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
