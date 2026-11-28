import { activatable, FOCUS_RING } from '../lib/activatable'
import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { SessionEntry } from '../hooks/useKnightSession'
import { formatCost, formatTimestamp, formatTimestampOrDate } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { entryIcon, entryLabel, entryTokens, entryTone } from '../lib/sessionEntries'
import { UntrustedText } from './UntrustedText'

export type SessionEntryDensity = 'page' | 'compact'

export function SessionEntryCard({ entry, density }: { entry: SessionEntry; density: SessionEntryDensity }) {
  return density === 'page' ? <PageCard entry={entry} /> : <CompactCard entry={entry} />
}

function PageCard({ entry }: { entry: SessionEntry }) {
  const [expanded, setExpanded] = useState(false)
  const label = entryLabel(entry)

  return (
    <div
      className={`border rounded-lg p-3 cursor-pointer transition-colors ${entryTone(entry).card} ${FOCUS_RING}`}
      {...activatable(() => setExpanded(e => !e), expanded)}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className="shrink-0">{entryIcon(entry)}</span>
        {entry.toolName && (
          <span className="font-mono text-purple-400 text-xs bg-purple-500/10 px-1.5 py-0.5 rounded shrink-0">{entry.toolName}</span>
        )}
        <span className={`truncate flex-1 min-w-0 ${label.placeholder ? 'text-gray-500 italic' : 'text-gray-400'}`}>{sanitizeText(label.text)}</span>
        {entry.cost != null && entry.cost > 0 && (
          <span className="text-roundtable-gold text-xs shrink-0">{formatCost(entry.cost)}</span>
        )}
        {entry.tokens && (
          <span className="text-gray-600 text-xs shrink-0">{entryTokens(entry)}t</span>
        )}
        <span className="text-gray-600 text-xs shrink-0 whitespace-nowrap tabular-nums">{formatTimestampOrDate(entry.timestamp)}</span>
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 border-t border-roundtable-steel/30 pt-2">
          {entry.input && (
            <div>
              <span className="text-[10px] text-gray-500 uppercase">Input</span>
              <UntrustedText text={entry.input} className="text-xs text-gray-400 font-mono whitespace-pre-wrap max-h-48 overflow-auto mt-0.5" />
            </div>
          )}
          {entry.output && (
            <div>
              <span className="text-[10px] text-gray-500 uppercase">Output</span>
              <UntrustedText text={entry.output} className="text-xs text-gray-400 font-mono whitespace-pre-wrap max-h-48 overflow-auto mt-0.5" />
            </div>
          )}
          {entry.text && !entry.input && !entry.output && (
            <UntrustedText text={entry.text} className="text-xs text-gray-400 whitespace-pre-wrap max-h-64 overflow-auto" />
          )}
        </div>
      )}
    </div>
  )
}

function CompactCard({ entry }: { entry: SessionEntry }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className={`bg-roundtable-slate rounded-lg p-2.5 border border-roundtable-steel/50 cursor-pointer hover:border-roundtable-gold/30 transition-colors ${FOCUS_RING}`}
      {...activatable(() => setExpanded(e => !e), expanded)}
    >
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className={`text-xs px-1.5 py-0.5 rounded ${entryTone(entry).badge}`}>
            {entryIcon(entry)}
            {' '}{entry.type}
          </span>
          {entry.toolName && (
            <span className="text-xs text-purple-400 font-mono">{entry.toolName}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-xs text-gray-600">{formatTimestamp(entry.timestamp)}</span>
          <ChevronRight className={`w-3 h-3 text-gray-600 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </div>
      </div>
      {entry.text && (
        <p className={`text-xs text-gray-400 mt-1 ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-4'}`}>{sanitizeText(entry.text)}</p>
      )}
      {entry.input && (
        <p className={`text-xs text-gray-500 mt-1 font-mono ${expanded ? 'whitespace-pre-wrap break-all' : 'line-clamp-3'}`}>→ {sanitizeText(entry.input)}</p>
      )}
      {entry.output && (
        <p className={`text-xs text-gray-500 mt-1 font-mono ${expanded ? 'whitespace-pre-wrap break-all' : 'line-clamp-3'}`}>← {sanitizeText(entry.output)}</p>
      )}
      {entry.cost != null && entry.cost > 0 && (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-roundtable-gold">{formatCost(entry.cost)}</span>
          {entry.tokens && (
            <span className="text-xs text-gray-600">{entryTokens(entry)} tokens</span>
          )}
        </div>
      )}
    </div>
  )
}
