import { apiGet, apiGetText, ApiError } from '../lib/api'
import { useState, useEffect, useCallback, useRef } from 'react'
import { BookOpen, Calendar, FileText, ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import { Spinner, EmptyState, PageHeader, ErrorBanner } from '../components/ui'
import { SafeMarkdown } from '../components/SafeMarkdown'
import { useVisibleInterval } from '../hooks/useVisibleInterval'

// Helper to format date in human-friendly format
function formatDate(dateStr: string): string {
  try {
    const [year, month, day] = dateStr.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    return date.toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    })
  } catch {
    return dateStr
  }
}

// Helper to calculate reading time (assuming ~200 words per minute)
function calculateReadingTime(text: string): string {
  const words = text.trim().split(/\s+/).length
  const minutes = Math.ceil(words / 200)
  return `${minutes} min read`
}

// Helper to count words
function countWords(text: string): number {
  return text.trim().split(/\s+/).length
}

const LIST_REFRESH_MS = 60_000

interface BriefingEntry {
  name: string
  dir: string
}

interface ContentError {
  /** Only a 404 means "no briefing for this date"; other failures can be retried. */
  notFound: boolean
  message: string
}

const entryKey = (b: BriefingEntry) => `${b.dir}/${b.name}`

// Newest first: the names are dates, so reverse alphabetical order is reverse chronological.
const sortNewestFirst = (entries: BriefingEntry[]) =>
  [...entries].sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir)).reverse()

export function BriefingsPage() {
  const [briefings, setBriefings] = useState<BriefingEntry[]>([])
  const [selected, setSelected] = useState<BriefingEntry | null>(null)
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)
  const [contentError, setContentError] = useState<ContentError | null>(null)
  const [retryCount, setRetryCount] = useState(0)
  const listLoaded = useRef(false)

  const loadList = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await apiGet<BriefingEntry[]>('/api/briefings', { signal })
      if (signal.aborted) return
      const sorted = sortNewestFirst(data)
      listLoaded.current = true
      setBriefings(sorted)
      setListError(null)
      // Keep the open briefing on refresh; auto-select the newest only when nothing is selected yet.
      setSelected((prev) => prev ?? sorted[0] ?? null)
    } catch (e) {
      if (signal.aborted) return
      // A failed refresh keeps the list on screen; only a failed first load is shown as an error.
      if (!listLoaded.current) setListError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const ctl = new AbortController()
    loadList(ctl.signal)
    return () => ctl.abort()
  }, [loadList])

  // Pick up briefings written while the page is open.
  useVisibleInterval((signal) => loadList(signal), LIST_REFRESH_MS)

  // Keyed by value, not object identity: a list refresh must not refetch the open briefing.
  const selectedKey = selected ? entryKey(selected) : ''

  useEffect(() => {
    if (!selected) return
    const ctl = new AbortController()
    setContentLoading(true)
    setContentError(null)
    setContent('')

    const date = selected.name.replace('.md', '')
    const query = selected.dir ? `?dir=${encodeURIComponent(selected.dir)}` : ''
    apiGetText(`/api/briefings/${date}${query}`, { signal: ctl.signal })
      .then((text) => {
        // A late answer for a previous selection must not overwrite the current one.
        if (ctl.signal.aborted) return
        setContent(text)
        setContentLoading(false)
      })
      .catch((e) => {
        if (ctl.signal.aborted) return
        setContentError({
          notFound: e instanceof ApiError && e.status === 404,
          message: e instanceof Error ? e.message : 'Unknown error',
        })
        setContentLoading(false)
      })
    return () => ctl.abort()
  }, [selectedKey, retryCount])

  // The list is newest first, so "older" is the next index and "newer" the previous one.
  const selectedIndex = selected ? briefings.findIndex((b) => entryKey(b) === selectedKey) : -1
  const older = selectedIndex >= 0 ? briefings[selectedIndex + 1] : undefined
  const newer = selectedIndex > 0 ? briefings[selectedIndex - 1] : undefined

  const selectedDate = selected ? selected.name.replace('.md', '') : ''
  const wordCount = content ? countWords(content) : 0
  const readingTime = content ? calculateReadingTime(content) : ''

  return (
    <div>
      <PageHeader icon={BookOpen} title="Chronicles" />

      <div className="flex gap-6">
        {/* Archive sidebar */}
        <div className="w-64 shrink-0">
          <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-4">
            <h2 className="text-sm font-medium text-gray-400 mb-3">Archives</h2>
            {loading && <p className="text-gray-500 text-sm">Loading...</p>}
            {!loading && !listError && briefings.length === 0 && (
              <p className="text-gray-500 text-xs">No briefings yet</p>
            )}
            <div className="space-y-1 max-h-[70vh] overflow-y-auto">
              {briefings.map((b) => (
                <button
                  key={entryKey(b)}
                  onClick={() => setSelected(b)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                    selected && entryKey(selected) === entryKey(b)
                      ? 'bg-roundtable-gold/10 text-roundtable-gold'
                      : 'text-gray-400 hover:text-white hover:bg-roundtable-steel/50'
                  }`}
                >
                  <span>📜 {b.name.replace('.md', '')}</span>
                  <span className="block text-xs text-gray-500 truncate" title={b.dir}>{b.dir}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Briefing content */}
        <div className="flex-1">
          {/* Empty state when no briefings exist */}
          {listError ? (
            <ErrorBanner>Failed to load briefings: {listError}</ErrorBanner>
          ) : !loading && briefings.length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="No briefings yet"
              sub="Configure a morning chain to generate daily briefings."
            />
          ) : !selected ? (
            <EmptyState
              icon={BookOpen}
              title="Select a chronicle from the archive"
              sub={`${briefings.length} briefings available`}
            />
          ) : (
            <div>
              {/* Date navigation */}
              <div className="flex items-center gap-3 mb-4">
                <button
                  onClick={() => older && setSelected(older)}
                  disabled={!older}
                  className="p-2 rounded-lg hover:bg-roundtable-steel/50 text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
                  title="Older briefing"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                
                <div className="flex items-center gap-3 flex-1">
                  <Calendar className="w-5 h-5 text-roundtable-gold" />
                  <h2 className="text-lg font-semibold text-white">
                    {formatDate(selectedDate)}
                  </h2>
                </div>
                
                <button
                  onClick={() => newer && setSelected(newer)}
                  disabled={!newer}
                  className="p-2 rounded-lg hover:bg-roundtable-steel/50 text-gray-400 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-gray-400"
                  title="Newer briefing"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>

              {/* Metadata bar */}
              {!contentLoading && !contentError && content && (
                <div className="flex items-center gap-4 mb-4 text-xs text-gray-500">
                  <span className="flex items-center gap-1">
                    <FileText className="w-3 h-3" />
                    {wordCount.toLocaleString()} words
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {readingTime}
                  </span>
                  {selected?.dir && <span title="Source directory">📁 {selected.dir}</span>}
                </div>
              )}

              {/* Content area */}
              <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl p-6 min-h-[400px]">
                {contentLoading ? (
                  <div className="flex items-center justify-center py-20">
                    <Spinner />
                  </div>
                ) : contentError?.notFound ? (
                  <EmptyState
                    icon={FileText}
                    title="No briefing available for this date"
                    sub="Try selecting another briefing from the archive"
                  />
                ) : contentError ? (
                  <div className="space-y-4">
                    <ErrorBanner>Failed to load briefing: {contentError.message}</ErrorBanner>
                    <button
                      onClick={() => setRetryCount((n) => n + 1)}
                      className="px-3 py-1.5 rounded-lg text-sm bg-roundtable-steel/50 text-gray-300 hover:text-white transition-colors"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="prose prose-invert prose-sm max-w-none 
                    prose-headings:text-white prose-headings:font-semibold
                    prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg
                    prose-p:text-gray-300 prose-p:leading-relaxed
                    prose-a:text-roundtable-gold prose-a:no-underline hover:prose-a:underline
                    prose-strong:text-white prose-strong:font-semibold
                    prose-code:text-roundtable-gold prose-code:bg-roundtable-steel/50 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none
                    prose-pre:bg-roundtable-steel/30 prose-pre:border prose-pre:border-roundtable-steel
                    prose-ul:text-gray-300 prose-ol:text-gray-300
                    prose-li:text-gray-300 prose-li:marker:text-roundtable-gold
                    prose-blockquote:border-l-roundtable-gold prose-blockquote:text-gray-400
                    prose-hr:border-roundtable-steel">
                    <SafeMarkdown>{content}</SafeMarkdown>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
