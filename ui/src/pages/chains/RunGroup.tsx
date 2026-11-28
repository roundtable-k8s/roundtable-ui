import { apiGet } from '../../lib/api'
import { useState, useEffect, useCallback, useRef } from 'react'
import { ChevronDown, ChevronRight, Repeat } from 'lucide-react'
import type { Chain, ChainRunGroup } from '../../lib/types'
import { useWebSocket } from '../../hooks/useWebSocket'
import { appendPage, applyChainUpdate, parseChainUpdate, runGroupSummary, upsertNewestFirst } from '../../lib/chains'
import { GROUP_PAGE_SIZE, groupRunsUrl } from './urls'
import { ChainCard } from './ChainCard'

/**
 * The run copies of one template as one collapsed row ("pr-pipeline: 150
 * runs, 148 succeeded, …"). Expanding loads the newest copies a page at a
 * time; live updates of loaded copies are applied in place.
 */
export function RunGroup({ group, focusChain, focusDetail, refreshToken }: {
  group: ChainRunGroup
  focusChain: string
  focusDetail: Chain | null
  refreshToken: number
}) {
  const focusHere = focusDetail?.runTemplate === group.template
  const [open, setOpen] = useState(focusHere)
  useEffect(() => { if (focusHere) setOpen(true) }, [focusHere])
  const [runs, setRuns] = useState<Chain[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const { subscribeTopic } = useWebSocket()
  const runsRef = useRef(runs)
  runsRef.current = runs
  const loadedRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback((offset: number, limit: number) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoading(true)
    apiGet<Chain[]>(groupRunsUrl(group.template, offset, limit), { signal: controller.signal })
      .then(page => {
        if (controller.signal.aborted) return
        setRuns(prev => (offset === 0 ? page || [] : appendPage(prev, page || [])))
        loadedRef.current = true
        setLoaded(true)
        setError('')
      })
      .catch(e => {
        if (e?.name !== 'AbortError') setError(e instanceof Error ? e.message : 'Failed to load runs')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
  }, [group.template])

  // (Re)load the newest copies on open and on every page refresh.
  useEffect(() => {
    if (!open) return
    load(0, Math.max(GROUP_PAGE_SIZE, runsRef.current.length))
  }, [open, refreshToken, load])
  useEffect(() => () => { abortRef.current?.abort() }, [])

  // Live updates of this template's copies, once a page is loaded.
  useEffect(() => subscribeTopic('chain', (data, msg) => {
    if (!loadedRef.current) return
    const u = parseChainUpdate(data, msg)
    if (!u) return
    if (u.op === 'delete') setRuns(prev => applyChainUpdate(prev, u))
    else if (u.chain.runTemplate === group.template) setRuns(prev => upsertNewestFirst(prev, u.chain))
  }), [subscribeTopic, group.template])

  const shown = focusHere && focusDetail && !runs.some(r => r.name === focusDetail.name)
    ? [focusDetail, ...runs]
    : runs
  const remaining = Math.max(0, group.runs - runs.length)

  return (
    <section aria-label={`runs of ${group.template}`} className="bg-roundtable-slate border border-roundtable-steel rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-roundtable-steel/30 transition-colors"
      >
        {open
          ? <ChevronDown className="w-4 h-4 text-gray-400 flex-shrink-0" />
          : <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />}
        <Repeat className="w-4 h-4 text-roundtable-gold flex-shrink-0" />
        <span className="text-sm text-gray-200">{runGroupSummary(group)}</span>
        {!group.templateExists && <span className="text-xs text-gray-500">(template deleted)</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {error && <p className="text-xs text-red-400 px-2">Failed to load runs: {error}</p>}
          {!loaded && !error && shown.length === 0 && <p className="text-xs text-gray-500 px-2">Loading runs…</p>}
          {shown.map(c => (
            <ChainCard key={`${c.namespace}/${c.name}`} chain={c} focused={c.name === focusChain} />
          ))}
          {loaded && remaining > 0 && (
            <button
              type="button"
              onClick={() => load(runs.length, GROUP_PAGE_SIZE)}
              disabled={loading}
              className="text-xs px-3 py-1.5 rounded-lg border border-roundtable-steel text-gray-300 hover:text-white hover:border-gray-500 disabled:opacity-50"
            >
              {loading ? 'Loading…' : `Load more (${remaining} more)`}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
