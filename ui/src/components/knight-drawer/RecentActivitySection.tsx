import { Clock } from 'lucide-react'
import { Spinner } from '../ui'
import { SessionEntryCard } from '../SessionEntryCard'
import type { SessionEntry } from '../../hooks/useKnightSession'

export function RecentActivitySection({ recent, recentLoading }: { recent: SessionEntry[]; recentLoading: boolean }) {
  return (
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
          <SessionEntryCard key={entry.id} entry={entry} density="compact" />
        ))}
      </div>
    </div>
  )
}
