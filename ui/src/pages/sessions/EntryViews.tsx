import { activatable, FOCUS_RING } from '../../lib/activatable'
import { useState } from 'react'
import { TreePine, ChevronRight, ChevronDown, MessageSquare } from 'lucide-react'
import type { SessionEntry, SessionTreeNode, KnightSessionStats } from '../../hooks/useKnightSession'
import { EmptyState } from '../../components/ui'
import { formatTimestampOrDate } from '../../lib/format'
import { SessionEntryCard } from '../../components/SessionEntryCard'
import { entryTypeIcons } from '../../lib/sessionEntries'

// Cap the visual indent so a long, near-linear parent→child chain doesn't
// march the content off the right edge (and squeeze the timestamp into a wrap).
const MAX_TREE_INDENT_DEPTH = 12
const TREE_INDENT_PX = 16


export function TreeNodeView({ node, depth = 0 }: { node: SessionTreeNode & { children?: SessionTreeNode[] }; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2)
  const hasChildren = (node.children?.length ?? 0) > 0
  const indent = Math.min(depth, MAX_TREE_INDENT_DEPTH) * TREE_INDENT_PX

  return (
    <div>
      <div
        className={`flex items-center gap-2 py-1 pr-2 rounded hover:bg-roundtable-steel/30 cursor-pointer text-sm ${FOCUS_RING}`}
        {...activatable(() => setExpanded(e => !e), hasChildren ? expanded : undefined)}
      >
        {/* Indented label region — only this shrinks/truncates, keeping the
            timestamp pinned to a fixed right column. */}
        <div className="flex items-center gap-2 min-w-0 flex-1" style={{ paddingLeft: indent }}>
          {hasChildren ? (
            expanded
              ? <ChevronDown className="w-3 h-3 text-gray-500 shrink-0" />
              : <ChevronRight className="w-3 h-3 text-gray-500 shrink-0" />
          ) : <span className="w-3 shrink-0" />}
          <span className="shrink-0">{entryTypeIcons[node.type] || '●'}</span>
          <span className="text-gray-300 truncate">{node.summary || node.label || node.type}</span>
        </div>
        {node.childrenCount > 0 && (
          <span className="text-xs text-gray-600 shrink-0">{node.childrenCount}</span>
        )}
        <span className="text-xs text-gray-600 shrink-0 whitespace-nowrap tabular-nums">{formatTimestampOrDate(node.timestamp)}</span>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children?.map(child => (
            <TreeNodeView key={child.id} node={child as SessionTreeNode & { children?: SessionTreeNode[] }} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolCallCard({ entry }: { entry: SessionEntry }) {
  return <SessionEntryCard entry={entry} density="page" />
}

type TreeRoot = SessionTreeNode & { children: SessionTreeNode[] }

export function TreeView({ tree, isArchived, stats }: { tree: TreeRoot[]; isArchived: boolean; stats: KnightSessionStats | null }) {
  return (
    <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4">
      {tree.length === 0 ? (
        <EmptyState
          icon={TreePine}
          title={isArchived
            ? 'Tree view is available for the live session. Use Timeline or Tools to replay this archived session.'
            : stats?.supported === false
              ? 'Session introspection not available for this knight.'
              : 'No session tree data. Dispatch a task to see activity.'}
        />
      ) : (
        <div className="max-h-[70vh] overflow-auto">
          {tree.map(node => (
            <TreeNodeView key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  )
}

export function EntryList({ entries, isArchived, stats, hasFilter }: { entries: SessionEntry[]; isArchived: boolean; stats: KnightSessionStats | null; hasFilter: boolean }) {
  return (
    <div className="space-y-2">
      {entries.length === 0 && (
        <EmptyState
          icon={MessageSquare}
          title={!isArchived && stats?.supported === false
            ? 'Session introspection not available for this knight.'
            : hasFilter
              ? 'No entries match your filters.'
              : isArchived
                ? 'This archived session has no entries.'
                : 'No session entries found. Dispatch a task to see activity.'}
        />
      )}
      {entries.map(entry => (
        <ToolCallCard key={entry.id} entry={entry} />
      ))}
    </div>
  )
}
