import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { Modal } from './ui'
import { apiGet } from '../lib/api'
import { withTable } from '../lib/tables'
import { buildEntries, rank, type PaletteEntry, type PaletteSources } from '../lib/palette'
import { CHAINS_LIST_URL } from '../pages/Chains'
import type { ScheduleList } from '../lib/schedules'

type Named = { name: string; namespace?: string }

const BADGE: Record<string, string> = {
  page: 'bg-gray-500/20 text-gray-300',
  knight: 'bg-roundtable-gold/20 text-roundtable-gold',
  chain: 'bg-sky-500/20 text-sky-300',
  schedule: 'bg-purple-500/20 text-purple-300',
  mission: 'bg-emerald-500/20 text-emerald-300',
  trigger: 'bg-orange-500/20 text-orange-300',
}

export function CommandPalette({ onClose, pages, table }: {
  onClose: () => void
  pages: { path: string; label: string }[]
  table: string
}) {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [sources, setSources] = useState<Omit<PaletteSources, 'pages'>>({})
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState<string[]>([])
  const listRef = useRef<HTMLUListElement>(null)

  // Fetched once per open (the palette is unmounted when closed).
  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    const bad: string[] = []
    const get = <T,>(label: string, url: string): Promise<T | null> =>
      apiGet<T>(withTable(url, table), { signal }).catch(() => { if (!signal.aborted) bad.push(label); return null })
    Promise.all([
      get<Named[]>('knights', '/api/fleet'),
      get<Named[]>('chains', CHAINS_LIST_URL),
      get<ScheduleList>('schedules', '/api/schedules'),
      get<Named[]>('missions', '/api/missions'),
      get<Named[]>('triggers', '/api/triggers'),
    ]).then(([knights, chains, schedules, missions, triggers]) => {
      if (signal.aborted) return
      setSources({ knights: knights ?? [], chains: chains ?? [], schedules: schedules?.schedules ?? [], missions: missions ?? [], triggers: triggers ?? [] })
      setFailed(bad)
      setLoading(false)
    })
    return () => controller.abort()
  }, [table])

  const entries = useMemo(() => buildEntries({ ...sources, pages }), [sources, pages])
  const results = useMemo(() => rank(entries, query), [entries, query])
  const sel = Math.min(active, Math.max(results.length - 1, 0))

  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView?.({ block: 'nearest' })
  }, [sel])

  const go = (e: PaletteEntry | undefined) => {
    if (!e) return
    onClose()
    navigate(e.to)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(sel + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(sel - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(results[sel]) }
  }

  return (
    <Modal onClose={onClose} title="Search" icon={<Search className="w-5 h-5" aria-hidden="true" />}>
      <div className="p-4 space-y-3">
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={results.length ? `palette-opt-${sel}` : undefined}
          aria-label="Search knights, chains, schedules, missions and triggers"
          placeholder="Search knights, chains, schedules, missions, triggers…"
          value={query}
          onChange={e => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onKeyDown}
          className="w-full rounded-lg border border-roundtable-steel bg-roundtable-navy px-3 py-2 text-white focus:outline-none focus:border-roundtable-gold"
        />
        {failed.length > 0 && (
          <p role="alert" className="text-xs text-yellow-300">Could not load: {failed.join(', ')}</p>
        )}
        {loading && <p role="status" className="text-xs text-gray-400">Loading…</p>}
        <ul id="palette-results" role="listbox" ref={listRef} className="max-h-80 overflow-y-auto">
          {results.map((r, i) => (
            <li key={`${r.kind}:${r.to}:${r.sub}`} id={`palette-opt-${i}`} role="option" aria-selected={i === sel}
              onMouseEnter={() => setActive(i)} onClick={() => go(r)}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer ${i === sel ? 'bg-roundtable-gold/10' : ''}`}>
              <span className={`px-2 py-0.5 rounded text-xs ${BADGE[r.kind]}`}>{r.kind}</span>
              <span className="text-white truncate">{r.label}</span>
              <span className="ml-auto text-xs text-gray-500 truncate">{r.sub}</span>
            </li>
          ))}
        </ul>
        {!loading && results.length === 0 && <p className="text-sm text-gray-400">No matches</p>}
      </div>
    </Modal>
  )
}
