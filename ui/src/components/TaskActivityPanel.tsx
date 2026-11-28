import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowDown, Bot, CheckCircle2, Loader2, Play, Scissors, Wrench, X, XCircle } from 'lucide-react'
import { Drawer, Badge } from './ui'
import { UntrustedText } from './UntrustedText'
import { useTaskActivity } from '../hooks/useTaskActivity'
import { useNow } from '../hooks/useNow'
import { useWebSocket } from '../hooks/useWebSocket'
import { apiGet } from '../lib/api'
import { parseEvent } from '../lib/events'
import { formatCost, formatTimestamp, formatNumber } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { sessionsLink } from '../lib/sessions'
import {
  buildTimeline,
  elapsedMs,
  formatMs,
  summarizeActivity,
  type ActivitySummary,
  type TimelineItem,
} from '../lib/activity'

/** Header values known before the stream delivers them (e.g. from /api/running). */
export interface TaskActivityHint {
  knight?: string
  pod?: string
  node?: string
  runId?: string
  chainName?: string
  stepName?: string
  model?: string
  startedAt?: string
  costUsd?: number
}

interface TaskActivityPanelProps {
  taskId: string
  hint?: TaskActivityHint
  /** Extra rows rendered under the header (e.g. running status). */
  extra?: ReactNode
  onClose: () => void
}

/** Distance from the bottom (px) within which the timeline counts as "at the bottom". */
const BOTTOM_SLACK_PX = 32

function chainHref(chainName: string): string {
  return `/chains?chain=${encodeURIComponent(chainName)}`
}

function Header({ taskId, s, now, finished }: { taskId: string; s: ActivitySummary; now: number; finished: boolean }) {
  const rows: Array<[string, ReactNode]> = [
    ['Knight', s.knight ? <span key="k" className="capitalize">{sanitizeText(s.knight)}</span> : '—'],
    ['Pod', s.pod ? <code key="p" className="break-all">{sanitizeText(s.pod)}</code> : '—'],
    ['Task ID', <code key="t" className="break-all">{sanitizeText(taskId)}</code>],
    ['Run ID', s.runId ? <code key="r" className="break-all">{sanitizeText(s.runId)}</code> : '—'],
    ['Chain / step', s.chainName ? (
      <Link key="c" to={chainHref(s.chainName)} className="text-roundtable-gold hover:underline">
        {sanitizeText(s.chainName)}
        {s.stepName && <span className="text-gray-400"> / {sanitizeText(s.stepName)}</span>}
      </Link>
    ) : '—'],
    ['Model', s.model ? sanitizeText(s.model) : '—'],
    [finished ? 'Duration' : 'Elapsed', formatMs(elapsedMs(s, now))],
    ['Cost', s.costUsd != null ? formatCost(s.costUsd) : '—'],
  ]
  return (
    <dl className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm" aria-label="Task details">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-gray-500">{k}</dt>
          <dd className="col-span-2 text-gray-200 tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function TruncatedBadge() {
  return <span className="ml-2 text-[10px] uppercase tracking-wide text-yellow-500/80" title="Preview was cut by the knight">truncated</span>
}

function ToolItem({ item, taskFinished }: { item: Extract<TimelineItem, { kind: 'tool' }>; taskFinished: boolean }) {
  const fin = item.finished
  const isError = fin?.isError === true
  const running = !fin && !taskFinished
  const at = item.started?.ts || fin?.ts
  const truncated = item.started?.truncated || fin?.truncated
  return (
    <li
      data-kind="tool"
      data-state={running ? 'running' : !fin ? 'unknown' : isError ? 'error' : 'ok'}
      className={`rounded-lg border px-3 py-2 ${isError ? 'border-red-500/40 bg-red-500/5' : 'border-purple-500/20 bg-purple-500/5'}`}
    >
      <div className="flex items-center gap-2 text-xs">
        {!fin && !running ? (
          <Wrench className="w-3.5 h-3.5 text-gray-500" aria-hidden />
        ) : running ? (
          <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" aria-label="running" />
        ) : isError ? (
          <XCircle className="w-3.5 h-3.5 text-red-400" aria-label="error" />
        ) : (
          <Wrench className="w-3.5 h-3.5 text-purple-400" aria-hidden />
        )}
        <span className={`font-medium ${isError ? 'text-red-300' : 'text-gray-200'}`}>{sanitizeText(item.tool)}</span>
        {isError && <span className="text-red-400">error</span>}
        {truncated && <TruncatedBadge />}
        <span className="ml-auto text-gray-500 tabular-nums">
          {running ? 'running…' : fin ? formatMs(fin.durationMs) : 'no finish event'}
        </span>
        {at && <span className="text-gray-600 tabular-nums whitespace-nowrap">{formatTimestamp(at)}</span>}
      </div>
      {item.started?.argsSummary && (
        <UntrustedText text={item.started.argsSummary} className="mt-1 text-xs text-gray-400 whitespace-pre-wrap break-all" collapseAfter={300} />
      )}
      {fin?.outputPreview && (
        <UntrustedText
          text={fin.outputPreview}
          className={`mt-1 text-xs whitespace-pre-wrap break-all border-l-2 pl-2 ${isError ? 'text-red-300/90 border-red-500/40' : 'text-gray-500 border-roundtable-steel'}`}
          collapseAfter={300}
        />
      )}
    </li>
  )
}

function TimelineRow({ item, taskFinished }: { item: TimelineItem; taskFinished: boolean }) {
  switch (item.kind) {
    case 'truncated':
      return (
        <li data-kind="truncated" className="flex items-center gap-2 text-xs text-yellow-400/90 border border-dashed border-yellow-500/30 rounded-lg px-3 py-1.5">
          <Scissors className="w-3.5 h-3.5" aria-hidden />
          {formatNumber(item.count)} earlier {item.count === 1 ? 'event' : 'events'} no longer buffered
        </li>
      )
    case 'gap': {
      const n = item.toSeq - item.fromSeq + 1
      return (
        <li data-kind="gap" className="flex items-center gap-2 text-xs text-orange-400/90 border border-dashed border-orange-500/30 rounded-lg px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
          {n === 1 ? `1 event missed (seq ${item.fromSeq})` : `${n} events missed (seq ${item.fromSeq}–${item.toSeq})`}
        </li>
      )
    }
    case 'started':
      return (
        <li data-kind="started" className="flex items-center gap-2 text-xs text-blue-300 px-1">
          <Play className="w-3.5 h-3.5" aria-hidden />
          Task started{item.event.pod ? <> on <code>{sanitizeText(item.event.pod)}</code></> : null}
          {item.event.queuedFor != null && <span className="text-gray-500">(queued {formatMs(item.event.queuedFor)})</span>}
          {item.event.ts && <span className="ml-auto text-gray-600 tabular-nums">{formatTimestamp(item.event.ts)}</span>}
        </li>
      )
    case 'message':
      return (
        <li data-kind="message" className="rounded-lg border border-green-500/20 bg-green-500/5 px-3 py-2">
          <div className="flex items-center gap-2 text-xs mb-1">
            <Bot className="w-3.5 h-3.5 text-green-400" aria-hidden />
            <span className="font-medium text-green-300">Assistant</span>
            {item.event.truncated && <TruncatedBadge />}
            {item.event.ts && <span className="ml-auto text-gray-600 tabular-nums">{formatTimestamp(item.event.ts)}</span>}
          </div>
          {item.event.preview ? (
            <UntrustedText text={item.event.preview} className="text-sm text-gray-200 whitespace-pre-wrap break-words" collapseAfter={600} />
          ) : (
            <p className="text-xs text-gray-500 italic">No preview (content capture is off for this knight)</p>
          )}
        </li>
      )
    case 'tool':
      return <ToolItem item={item} taskFinished={taskFinished} />
    case 'finished': {
      const ok = item.event.success !== false
      return (
        <li data-kind="finished" className={`flex items-center gap-2 text-xs px-1 ${ok ? 'text-green-300' : 'text-red-300'}`}>
          {ok ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden /> : <XCircle className="w-3.5 h-3.5" aria-hidden />}
          Task {ok ? 'finished' : 'failed'}
          {!ok && item.event.errorClass && <span>({sanitizeText(item.event.errorClass)})</span>}
          {item.event.durationMs != null && <span className="text-gray-500">in {formatMs(item.event.durationMs)}</span>}
          {item.event.ts && <span className="ml-auto text-gray-600 tabular-nums">{formatTimestamp(item.event.ts)}</span>}
        </li>
      )
    }
  }
}

/** Result of the task from the shared event feed, plus a transcript link if the pod still exists. */
function AfterFinish({ taskId, s }: { taskId: string; s: ActivitySummary }) {
  const { events } = useWebSocket()
  const result = useMemo(() => {
    for (const e of events) {
      if (e.type !== 'result') continue
      const parsed = parseEvent(e)
      if (parsed.taskId === taskId) return parsed.data
    }
    return null
  }, [events, taskId])

  // The transcript lives in the pod's workspace: only link it while that pod is
  // still the knight's pod.
  const [podAlive, setPodAlive] = useState<boolean | null>(null)
  useEffect(() => {
    if (!s.knight || !s.pod) return
    let cancelled = false
    apiGet<{ podName?: string }>(`/api/fleet/${encodeURIComponent(s.knight.toLowerCase())}`)
      .then((d) => { if (!cancelled) setPodAlive(d?.podName === s.pod) })
      .catch(() => { if (!cancelled) setPodAlive(false) })
    return () => { cancelled = true }
  }, [s.knight, s.pod])

  return (
    <section className="mt-3 pt-3 border-t border-roundtable-steel space-y-2" aria-label="After finish">
      <div>
        <h3 className="text-xs font-semibold text-gray-400 mb-1">Result</h3>
        {result ? (
          <div className="text-xs">
            <span className={result.success === false ? 'text-red-400' : 'text-green-400'}>
              {result.success === false ? 'Failed' : 'Succeeded'}
            </span>
            <UntrustedText
              text={typeof result.result === 'string' ? result.result : ''}
              className="mt-1 text-xs text-gray-300 whitespace-pre-wrap break-words max-h-64 overflow-y-auto bg-roundtable-navy/50 rounded p-2"
              collapseAfter={2000}
            />
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            The result is not in the recent feed yet. See <Link to="/flow" className="text-roundtable-gold hover:underline">Message Flow</Link>.
          </p>
        )}
      </div>
      {s.knight && (
        <div className="text-xs">
          {podAlive ? (
            <Link
              to={sessionsLink(s.knight, s.pod, s.runId)}
              className="text-roundtable-gold hover:underline"
            >
              Open full session transcript
            </Link>
          ) : podAlive === false ? (
            <span className="text-gray-500">
              Session transcript unavailable: pod {s.pod ? <code>{sanitizeText(s.pod)}</code> : 'of this task'} is no longer the knight's pod.
            </span>
          ) : null}
        </div>
      )}
    </section>
  )
}

/**
 * Task activity drawer (#214): live timeline of assistant messages and tool
 * calls for one task, with gap/truncation markers and auto-scroll that pauses
 * while the user scrolls up. All event content renders as plain text (#188).
 */
export function TaskActivityPanel({ taskId, hint, extra, onClose }: TaskActivityPanelProps) {
  const state = useTaskActivity(taskId)
  const { connected } = useWebSocket()
  const now = useNow()
  const items = useMemo(() => buildTimeline(state), [state])
  const summary = useMemo<ActivitySummary>(() => {
    const fromEvents = summarizeActivity(state.events)
    const merged: ActivitySummary = { ...fromEvents }
    if (hint) {
      for (const [k, v] of Object.entries(hint) as Array<[keyof TaskActivityHint, unknown]>) {
        if (merged[k] == null && v != null && v !== '') (merged as Record<string, unknown>)[k] = v
      }
    }
    return merged
  }, [state.events, hint])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [paused, setPaused] = useState(false)
  const [unseen, setUnseen] = useState(0)
  const lastCount = useRef(0)

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK_PX
    setPaused(!atBottom)
    if (atBottom) setUnseen(0)
  }

  useLayoutEffect(() => {
    const el = scrollRef.current
    const added = items.length - lastCount.current
    lastCount.current = items.length
    if (!el) return
    if (paused) {
      if (added > 0) setUnseen((n) => n + added)
      return
    }
    el.scrollTop = el.scrollHeight
  }, [items, paused])

  const resume = () => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setPaused(false)
    setUnseen(0)
  }

  return (
    <Drawer onClose={onClose} label={`Task activity ${taskId}`} widthClass="w-full max-w-2xl">
      <div className="flex flex-col h-full">
        <div className="p-6 pb-3 border-b border-roundtable-steel">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              Task activity
              {state.finished ? (
                <Badge tone="gray" strength="strong" className="font-medium">finished</Badge>
              ) : state.loaded ? (
                <Badge tone="blue" strength="strong" className="font-medium">live</Badge>
              ) : null}
            </h2>
            <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-200">
              <X className="w-5 h-5" />
            </button>
          </div>
          <Header taskId={taskId} s={summary} now={now} finished={state.finished} />
          {extra}
          {state.finished && <AfterFinish taskId={taskId} s={summary} />}
        </div>

        <div className="relative flex-1 min-h-0">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            data-testid="activity-timeline"
            className="h-full overflow-y-auto px-6 py-4"
          >
            {state.error && (
              <p role="alert" className="mb-3 text-xs text-red-400">Activity stream: {sanitizeText(state.error)}</p>
            )}
            {!connected && !state.loaded ? (
              <p className="text-sm text-gray-500">Waiting for the live connection…</p>
            ) : !state.loaded ? (
              <p className="text-sm text-gray-500" role="status">Loading activity…</p>
            ) : items.length === 0 ? (
              <p className="text-sm text-gray-500">No activity yet. Events appear here as the knight works.</p>
            ) : (
              <ol className="space-y-2" aria-label="Activity timeline">
                {items.map((item) => <TimelineRow key={item.key} item={item} taskFinished={state.finished} />)}
              </ol>
            )}
            {state.loaded && !connected && !state.finished && (
              <p className="mt-3 text-xs text-yellow-400">Disconnected — reconnecting; the timeline resumes with a fresh backlog.</p>
            )}
          </div>
          {paused && (
            <button
              type="button"
              onClick={resume}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 text-xs px-3 py-1.5 rounded-full bg-roundtable-gold text-roundtable-navy font-medium shadow-lg"
            >
              <ArrowDown className="w-3.5 h-3.5" aria-hidden />
              {unseen > 0 ? `${unseen} new — resume auto-scroll` : 'Resume auto-scroll'}
            </button>
          )}
        </div>
      </div>
    </Drawer>
  )
}
