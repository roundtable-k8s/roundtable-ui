import { History } from 'lucide-react'
import type { SessionHistoryItem } from '../../hooks/useKnightSession'
import { formatDateTime, formatNumber } from '../../lib/format'
import { groupLabel } from '../../lib/sessions'
import { sessionHistoryKey, sessionLabel } from './helpers'

type Grouped = { runId: string | null; pods: { pod: string | null; sessions: SessionHistoryItem[] }[] }[]

interface Props {
  sessions: SessionHistoryItem[]
  groupedSessions: Grouped
  selectedSession: string
  onSelectSession: (key: string) => void
  isArchived: boolean
}

// Session picker: live vs. a past (persisted) session
export function SessionPicker({ sessions, groupedSessions, selectedSession, onSelectSession, isArchived }: Props) {
  if (sessions.length === 0) return null
  return (
    <div className="flex items-center gap-3 mb-4 text-sm">
      <span className="text-gray-500 flex items-center gap-1.5"><History className="w-4 h-4" /> Session</span>
      <select
        value={selectedSession}
        onChange={e => onSelectSession(e.target.value)}
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
  )
}

// Archived session banner (replaces live stats when replaying history)
export function ArchivedBanner({ meta, onBack }: { meta: { total: number; hasMore: boolean; startedAt: string | null } | null; onBack: () => void }) {
  return (
    <div className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-3 mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span className="text-gray-300 font-medium">📼 Replaying archived session</span>
      {meta?.startedAt && (
        <span className="text-gray-500">Started {formatDateTime(meta.startedAt)}</span>
      )}
      {meta && (
        <span className="text-gray-500">{formatNumber(meta.total)} entries{meta.hasMore ? ' (showing first 300)' : ''}</span>
      )}
      <button onClick={onBack} className="text-roundtable-gold hover:underline ml-auto">
        ← Back to live
      </button>
    </div>
  )
}
