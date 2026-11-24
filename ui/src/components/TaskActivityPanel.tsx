import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowDown, MessageSquare, Scissors, Wrench, X } from 'lucide-react'
import { Drawer } from './ui'
import { UntrustedText } from './UntrustedText'
import { useTaskActivity } from '../hooks/useTaskActivity'
import { useWebSocket } from '../hooks/useWebSocket'
import { useNow } from '../hooks/useNow'
import { apiGet } from '../lib/api'
import { parseEvent } from '../lib/events'
import { formatCost } from '../lib/format'
import { formatAge, type RunningTask } from '../lib/running'
import { sanitizeText } from '../lib/untrusted'
import { buildTimeline, formatMs, type ActivityItem, type TimelineRow } from '../lib/activity'

/** Distance from the bottom (px) that still counts as "following" the stream. */
const FOLLOW_THRESHOLD_PX = 24

function TruncatedMark({ item }: { item?: ActivityItem }) {
  if (!item?.truncated) return null
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-yellow-400/80" title="The knight or API cut this event's text to its size limit">
      <Scissors className="w-3 h-3" aria-hidden /> truncated
    </span>
  )
}

function ToolRow({ row }: { row: Extract<TimelineRow, { kind: 'tool' }> }) {
  const base = row.started ?? row.finished!
  const fin = row.finished
  const failed = fin?.isError === true
  const state = !fin ? 'running' : failed ? 'error' : 'ok'
  return (
    <li data-kind="tool" data-state={state} className={`rounded-lg border px-3 py-2 ${failed ? 'border-red-500/30 bg-red-500/5' : 'border-roundtable-steel/60 bg-roundtable-navy/40'}`}>
      <div className="flex items-center gap-2 text-xs">
        <Wrench className={`w-3.5 h-3.5 ${failed ? 'text-red-400' : 'text-blue-400'}`} aria-hidden />
        <span className={`font-medium ${failed ? 'text-red-400' : 'text-gray-200'}`}>{sanitizeText(base.tool) || 'tool'}</span>
        {!fin && <span className="text-blue-400 animate-pulse">running…</span>}
        {fin && <span className="text-gray-500 tabular-nums">{formatMs(fin.durationMs)}</span>}
        {failed && <span className="px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px] font-semibold">ERROR</span>}
        <TruncatedMark item={row.started?.truncated ? row.started : fin} />
        <span className="ml-auto text-gray-600 tabular-nums">#{base.seq}</span>
      </div>
      {row.started?.argsSummary && (
        <UntrustedText text={row.started.argsSummary} className="mt-1 text-xs text-gray-400 whitespace-pre-wrap break-all font-mono" />
      )}
      {fin?.outputPreview && (
        <UntrustedText text={fin.outputPreview} className={`mt-1 text-xs whitespace-pre-wrap break-all font-mono ${failed ? 'text-red-300/80' : 'text-gray-500'}`} collapseAfter={300} />
      )}
    </li>
  )
}

function lifecycleLabel(item: ActivityItem): ReactNode {
  switch (item.type) {
    case 'task.started':
      return 'Task started'
    case 'task.finished':
      return item.success === false
        ? <span className="text-red-400">Task failed{item.errorClass ? ` (${sanitizeText(item.errorClass)})` : ''}</span>
        : <span className="text-green-400">Task finished</span>
    default:
      return sanitizeText(item.type)
  }
}

function Row({ row }: { row: TimelineRow }) {
  switch (row.kind) {
    case 'gap':
      return (
        <li data-kind="gap" className="flex items-center gap-2 text-xs text-yellow-400 border border-dashed border-yellow-500/30 rounded-lg px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
          {row.missing} event{row.missing === 1 ? '' : 's'} missing here (lost or dropped on the way)
        </li>
      )
    case 'tool':
      return <ToolRow row={row} />
    case 'message':
      return (
        <li data-kind="message" className="rounded-lg border border-roundtable-gold/20 bg-roundtable-gold/5 px-3 py-2">
          <div className="flex items-center gap-2 text-xs mb-1">
            <MessageSquare className="w-3.5 h-3.5 text-roundtable-gold" aria-hidden />
            <span className="text-roundtable-gold font-medium">Assistant</span>
            <TruncatedMark item={row.item} />
            <span className="ml-auto text-gray-600 tabular-nums">#{row.item.seq}</span>
          </div>
          <UntrustedText text={row.item.preview} as="p" className="text-sm text-gray-200 whitespace-pre-wrap break-words" />
        </li>
      )
    case 'lifecycle':
      return (
        <li data-kind="lifecycle" className="flex items-center gap-2 text-xs text-gray-400 px-1">
          <span>{lifecycleLabel(row.item)}</span>
          {row.item.type === 'task.finished' && row.item.durationMs != null && <span className="text-gray-500">after {formatMs(row.item.durationMs)}</span>}
          <span className="ml-auto text-gray-600 tabular-nums">#{row.item.seq}</span>
        </li>
      )
  }
}

/** The pod that served the knight's session, to tell whether a transcript still exists. */
function useKnightPod(knight: string | undefined, enabled: boolean): string | null | undefined {
  const [pod, setPod] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!enabled || !knight) return
    const controller = new AbortController()
    apiGet<{ podName?: string }>(`/api/fleet/${encodeURIComponent(knight.toLowerCase())}`, { signal: controller.signal })
      .then((d) => setPod(d.podName || null))
      .catch(() => { if (!controller.signal.aborted) setPod(null) })
    return () => controller.abort()
  }, [knight, enabled])
  return pod
}

interface TaskActivityPanelProps {
  taskId: string
  /** The task's in-flight registry entry, when it is still running. */
  running?: RunningTask
  onClose: () => void
}

/**
 * Task activity drawer (#184): header, live timeline of tool calls and
 * assistant messages, gap and truncation markers, auto-scroll that pauses
 * while the user scrolls up, and the result / transcript once finished.
 * Everything from the knight renders as plain text (#188).
 */
export function TaskActivityPanel({ taskId, running, onClose }: TaskActivityPanelProps) {
  const activity = useTaskActivity(taskId)
  const { connected, events } = useWebSocket()
  const now = useNow()
  const info = activity.task
  const rows = useMemo(() => buildTimeline(activity.entries), [activity.entries])

  const knight = info?.knight || running?.knight
  const pod = info?.pod || running?.pod
  const runId = info?.runId || running?.runId
  const chainName = info?.chainName || running?.chainName
  const stepName = info?.stepName || running?.stepName
  const model = info?.model || running?.model
  const startedAt = info?.startedAt || running?.startedAt
  const cost = info?.costUsd ?? running?.costUsd
  const finished = !!info?.finished

  const result = useMemo(() => {
    if (!finished) return undefined
    return (events ?? []).find((e) => e.type === 'result' && parseEvent(e).taskId === taskId)
  }, [events, finished, taskId])
  const resultData = result ? parseEvent(result).data : undefined

  const currentPod = useKnightPod(knight, finished)
  const transcriptAvailable = !!pod && currentPod === pod

  // Auto-scroll: follow new rows unless the user scrolled up.
  const listRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && following) el.scrollTop = el.scrollHeight
  }, [rows.length, following])
  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX)
  }

  let status: ReactNode
  if (finished) {
    status = info?.success === false
      ? <span className="text-red-400">failed{info.errorClass ? ` (${sanitizeText(info.errorClass)})` : ''}</span>
      : <span className="text-green-400">finished</span>
  } else if (running && running.status !== 'running') {
    status = <span className={running.status === 'lost' ? 'text-red-400' : 'text-yellow-400'}>{running.status}{running.reason ? ` (${sanitizeText(running.reason)})` : ''}</span>
  } else {
    status = <span className="text-blue-400">running</span>
  }

  const elapsed = finished && info?.durationMs != null
    ? formatMs(info.durationMs)
    : finished && startedAt && info?.finishedAt
      ? formatAge(startedAt, new Date(info.finishedAt).getTime())
      : formatAge(startedAt, now)

  const header: Array<[string, ReactNode]> = [
    ['Status', status],
    ['Knight', knight ? <span className="capitalize">{sanitizeText(knight)}</span> : '—'],
    ['Pod', pod ? <code className="break-all">{sanitizeText(pod)}</code> : '—'],
    ['Run ID', runId ? <code className="break-all">{sanitizeText(runId)}</code> : '—'],
    ['Chain / step', chainName
      ? <Link to={`/chains?chain=${encodeURIComponent(chainName)}`} className="text-roundtable-gold hover:underline">{sanitizeText(chainName)}{stepName && <span className="text-gray-400"> / {sanitizeText(stepName)}</span>}</Link>
      : '—'],
    ['Model', model ? sanitizeText(model) : '—'],
    ['Elapsed', elapsed],
    ['Cost', cost != null ? formatCost(cost) : '—'],
  ]

  return (
    <Drawer onClose={onClose} widthClass="w-full max-w-2xl">
      <div className="p-6 flex flex-col h-full" role="dialog" aria-label={`Task ${taskId}`}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-white">Task activity</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-200">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-xs text-gray-500 font-mono break-all mb-4">{taskId}</p>

        <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1.5 text-sm mb-4">
          {header.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-gray-500">{k}</dt>
              <dd className="text-gray-200 min-w-0">{v}</dd>
            </div>
          ))}
        </dl>

        {!connected && <p className="text-xs text-red-400 mb-2">Live feed disconnected; reconnecting…</p>}
        {activity.error && <p role="alert" className="text-xs text-red-400 mb-2">{activity.error}</p>}

        <div className="relative flex-1 min-h-[12rem]">
          <div
            ref={listRef}
            onScroll={onScroll}
            data-testid="activity-timeline"
            className="absolute inset-0 overflow-y-auto pr-1"
          >
            {activity.dropped > 0 && (
              <p data-kind="dropped" className="text-xs text-gray-500 mb-2">
                {activity.dropped} earlier event{activity.dropped === 1 ? '' : 's'} no longer buffered.
              </p>
            )}
            {!activity.loaded ? (
              <p className="text-sm text-gray-500" role="status">{connected ? 'Loading activity…' : 'Waiting for the live feed…'}</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-gray-500">No activity yet. Tool calls and assistant messages appear here as they happen.</p>
            ) : (
              <ol className="space-y-2" aria-label="Activity timeline">
                {rows.map((row) => <Row key={row.key} row={row} />)}
              </ol>
            )}
          </div>
          {!following && (
            <button
              type="button"
              onClick={() => setFollowing(true)}
              className="absolute bottom-2 right-4 flex items-center gap-1 text-xs bg-roundtable-gold text-roundtable-navy font-medium rounded-full px-3 py-1 shadow"
            >
              <ArrowDown className="w-3.5 h-3.5" aria-hidden /> Follow live
            </button>
          )}
        </div>

        {finished && (
          <div className="mt-4 border-t border-roundtable-steel pt-4 space-y-2 text-sm">
            <h3 className="font-semibold text-gray-300">Result</h3>
            {resultData ? (
              <UntrustedText
                text={resultData.result ?? resultData.summary ?? ''}
                className="text-xs text-gray-300 whitespace-pre-wrap break-words max-h-48 overflow-y-auto bg-roundtable-navy/50 rounded-lg p-3"
                collapseAfter={2000}
              />
            ) : (
              <p className="text-xs text-gray-500">
                The result is not in the live feed. See <Link to="/quests" className="text-roundtable-gold hover:underline">task history</Link>.
              </p>
            )}
            {knight && (
              transcriptAvailable ? (
                <Link to={`/sessions?knight=${encodeURIComponent(knight.toLowerCase())}`} className="inline-block text-roundtable-gold hover:underline text-xs">
                  Open full session transcript →
                </Link>
              ) : currentPod !== undefined ? (
                <p className="text-xs text-gray-500">Pod {pod ? sanitizeText(pod) : ''} is gone; its session transcript went with it.</p>
              ) : null
            )}
          </div>
        )}
      </div>
    </Drawer>
  )
}
