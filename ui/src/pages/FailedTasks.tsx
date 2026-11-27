import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Skull } from 'lucide-react'
import { useTableFilter } from '../hooks/useTableFilter'
import { useUrlParam } from '../hooks/useUrlParam'
import { inTable } from '../lib/tables'
import { apiGet, apiPost } from '../lib/api'
import { PageHeader, RefreshButton } from '../components/ui'
import { DeadLettersView } from '../components/DeadLettersView'
import { countLabel } from '../lib/format'
import { DEAD_LETTER_CAP } from '../hooks/useOpenDeadLetters'
import { DEAD_LETTERS_URL, deadLetterUrl, type DeadLetter, type RetryResult } from '../lib/deadLetters'

const STATES = ['all', 'open', 'retried', 'resolved'] as const
type StateFilter = (typeof STATES)[number]

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

export function FailedTasksPage() {
  const { table } = useTableFilter()
  const [all, setAll] = useState<DeadLetter[]>([])
  const [total, setTotal] = useState<number | undefined>(undefined)
  const [stateParam, setState] = useUrlParam('state', 'all', STATES)
  const state = stateParam as StateFilter
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // The state the rows on screen were loaded for; differs from `state` while a new response is pending.
  const [loadedState, setLoadedState] = useState<StateFilter>('all')
  const stale = loading && loadedState !== state
  const controller = useRef<AbortController | null>(null)

  // The gateway list has no table filter, so narrow at render time from the raw list.
  const entries = useMemo(() => all.filter((d) => inTable(table, d.table)), [all, table])

  const load = useCallback(async () => {
    controller.current?.abort()
    const ctl = new AbortController()
    controller.current = ctl
    setLoading(true)
    try {
      const url = state === 'all' ? DEAD_LETTERS_URL : `${DEAD_LETTERS_URL}?state=${state}`
      const data = await apiGet<{ deadLetters?: DeadLetter[]; total?: number }>(url, { signal: ctl.signal })
      if (ctl.signal.aborted) return
      setAll(data.deadLetters ?? [])
      setLoadedState(state)
      setTotal(typeof data.total === 'number' ? data.total : undefined)
      setError(null)
    } catch (e) {
      if (ctl.signal.aborted || isAbort(e)) return
      // Keep the previous rows; the error shows above them.
      setError(e instanceof Error ? e.message : 'Failed to load dead letters')
    } finally {
      if (controller.current === ctl) setLoading(false)
    }
  }, [state])

  useEffect(() => { load() }, [load])
  useEffect(() => () => controller.current?.abort(), [])

  const shown = all.length
  const capped = (total !== undefined && total > shown) || (total === undefined && shown >= DEAD_LETTER_CAP)
  const capNote = capped
    ? `Showing the newest ${shown}${total !== undefined ? ` of ${total}` : ' (the list is capped, there may be more)'}. Narrow with the state filter to see the rest.`
    : null

  const onRetry = (d: DeadLetter, force: boolean) =>
    apiPost<RetryResult>(`${DEAD_LETTERS_URL}/${encodeURIComponent(d.taskId)}/retry`, { force, ...(d.table ? { table: d.table } : {}) })
      .then((res) => { load(); return res })

  return (
    <div>
      <PageHeader icon={Skull} title="Failed & lost" subtitle={(loading || error) && shown === 0 ? undefined : capped ? `${shown}+ failed tasks` : countLabel(shown, shown, 'failed tasks', 'failed task')}>
        <RefreshButton onClick={load} loading={loading} />
      </PageHeader>
      <div className="mb-4">
        <label htmlFor="dl-state" className="text-sm text-gray-400 mb-1 block">State</label>
        <select id="dl-state" value={state} onChange={(e) => setState(e.target.value)}
          className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white">
          {STATES.map((s) => <option key={s} value={s}>{s === 'all' ? 'All states' : s}</option>)}
        </select>
      </div>
      {capNote && <p data-testid="dead-letters-cap" className="mb-4 text-sm text-yellow-400">{capNote}</p>}
      <div aria-busy={stale} className={stale ? 'opacity-50 transition-opacity' : undefined} data-testid="dead-letters-rows">
        <DeadLettersView
          entries={entries}
          loading={loading}
          error={error}
          onRetry={onRetry}
          onLoadDetail={(d) => apiGet<DeadLetter>(deadLetterUrl(d))}
          onLoadEntry={(taskId, table) => apiGet<DeadLetter>(deadLetterUrl({ taskId, table }))}
        />
      </div>
    </div>
  )
}
