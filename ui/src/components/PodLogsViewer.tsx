import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiGetText } from '../lib/api'
import { sanitizeText } from '../lib/untrusted'
import { mergePodLogs, podColor, podLogsUrl, shortPodName, type KnightPod, type KnightPodsResponse, type MergedLogLine } from '../lib/podLogs'
import { Spinner } from './ui'

/** Picker value for the merged view of every pod. */
export const ALL_PODS = '__all__'

interface Props {
  knightName: string
}

type LogsState =
  | { kind: 'single'; pod: string; text: string }
  | { kind: 'all'; lines: MergedLogLine[]; errors: { pod: string; message: string }[] }

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Unknown error')

/**
 * Pod logs for one knight (#218): pick a pod (default: the pod with the most
 * recent activity), a container and the previous (crashed) instance, or merge
 * every pod's tail into one stream with per-pod prefixes and colours.
 */
export function PodLogsViewer({ knightName }: Props) {
  const [pods, setPods] = useState<KnightPod[]>([])
  const [podsError, setPodsError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [container, setContainer] = useState<string>('')
  const [previous, setPrevious] = useState(false)
  const [logs, setLogs] = useState<LogsState | null>(null)
  const [logsError, setLogsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Drops responses of superseded requests (pod switched mid-fetch).
  const reqId = useRef(0)

  const loadPods = useCallback(async () => {
    try {
      const res = await apiGet<KnightPodsResponse>(`/api/fleet/${encodeURIComponent(knightName)}/pods`)
      setPods(res.pods)
      setPodsError(null)
      setSelected((cur) => (cur === ALL_PODS || res.pods.some((p) => p.name === cur) ? cur : res.default ?? res.pods[0]?.name ?? ''))
    } catch (e) {
      setPods([])
      setPodsError(errMsg(e))
    }
  }, [knightName])

  useEffect(() => {
    setSelected('')
    setContainer('')
    setPrevious(false)
    setLogs(null)
    loadPods()
  }, [loadPods])

  const pod = pods.find((p) => p.name === selected)
  // Stable dependency so a pod-list reload only refetches when the set changes.
  const podNames = pods.map((p) => p.name).join(',')
  const podIndex = useMemo(() => new Map(pods.map((p, i) => [p.name, i])), [pods])

  // Reset the container when it isn't in the newly selected pod.
  useEffect(() => {
    if (container && pod && !pod.containers.some((c) => c.name === container)) setContainer('')
  }, [pod, container])

  const fetchLogs = useCallback(async () => {
    if (!selected) return
    const id = ++reqId.current
    setLoading(true)
    setLogsError(null)
    try {
      if (selected === ALL_PODS) {
        const names = podNames ? podNames.split(',') : []
        const results = await Promise.allSettled(
          names.map((p) => apiGetText(podLogsUrl(knightName, { pod: p, container, previous, timestamps: true }))),
        )
        if (id !== reqId.current) return
        const streams: { pod: string; text: string }[] = []
        const errors: { pod: string; message: string }[] = []
        results.forEach((r, i) => {
          if (r.status === 'fulfilled') streams.push({ pod: names[i], text: r.value })
          else errors.push({ pod: names[i], message: errMsg(r.reason) })
        })
        setLogs({ kind: 'all', lines: mergePodLogs(streams), errors })
      } else {
        const text = await apiGetText(podLogsUrl(knightName, { pod: selected, container, previous }))
        if (id !== reqId.current) return
        setLogs({ kind: 'single', pod: selected, text })
      }
    } catch (e) {
      if (id !== reqId.current) return
      setLogs(null)
      setLogsError(errMsg(e))
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [knightName, selected, container, previous, podNames])

  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // Containers offered: the selected pod's, or the union across pods.
  const containers = useMemo(() => {
    const src = selected === ALL_PODS ? pods : pod ? [pod] : []
    return [...new Set(src.flatMap((p) => p.containers.map((c) => c.name)))]
  }, [selected, pods, pod])

  if (podsError) {
    return <p className="text-xs text-red-400">Error: {sanitizeText(podsError)}</p>
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1 text-gray-500">
          Pod
          <select
            aria-label="Pod"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded px-1.5 py-0.5 text-gray-200"
          >
            {pods.length === 0 && <option value="">No pods</option>}
            {pods.map((p) => (
              <option key={p.name} value={p.name}>
                {shortPodName(p.name, knightName)}
                {p.ready ? '' : ` (${p.phase.toLowerCase() || 'not ready'})`}
                {p.restarts > 0 ? ` ↻${p.restarts}` : ''}
              </option>
            ))}
            {pods.length > 1 && <option value={ALL_PODS}>All pods (merged)</option>}
          </select>
        </label>
        {containers.length > 1 && (
          <label className="flex items-center gap-1 text-gray-500">
            Container
            <select
              aria-label="Container"
              value={container}
              onChange={(e) => setContainer(e.target.value)}
              className="bg-roundtable-navy border border-roundtable-steel rounded px-1.5 py-0.5 text-gray-200"
            >
              <option value="">default</option>
              {containers.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1 text-gray-500" title="Logs of the previous (crashed) container instance">
          <input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} />
          Previous
        </label>
        <span className="ml-auto text-gray-500">Last 100 lines{selected === ALL_PODS ? ' per pod' : ''}</span>
        <button
          onClick={() => {
            loadPods()
            fetchLogs()
          }}
          className="text-roundtable-gold hover:text-roundtable-gold/80"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-center py-4">
          <div className="flex justify-center mb-2"><Spinner size="sm" /></div>
          <p className="text-gray-500 text-xs">Loading logs...</p>
        </div>
      ) : logsError ? (
        <pre data-testid="pod-logs" className="text-xs text-red-400 font-mono whitespace-pre-wrap break-words">
          Error: {sanitizeText(logsError)}
        </pre>
      ) : logs?.kind === 'all' ? (
        <pre data-testid="pod-logs" className="text-xs text-gray-300 font-mono overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words">
          {logs.errors.map((e) => (
            <div key={`err-${e.pod}`} className="text-red-400">
              <span className={podColor(podIndex.get(e.pod) ?? 0)}>[{shortPodName(e.pod, knightName)}]</span> Error: {sanitizeText(e.message)}
            </div>
          ))}
          {logs.lines.length === 0 && logs.errors.length === 0 && 'No logs available'}
          {logs.lines.map((l, i) => (
            <div key={i}>
              <span className={podColor(podIndex.get(l.pod) ?? 0)}>[{shortPodName(l.pod, knightName)}]</span> {sanitizeText(l.text)}
            </div>
          ))}
        </pre>
      ) : (
        <pre data-testid="pod-logs" className="text-xs text-gray-300 font-mono overflow-x-auto max-h-[300px] overflow-y-auto whitespace-pre-wrap break-words">
          {sanitizeText(logs?.text) || 'No logs available'}
        </pre>
      )}
    </div>
  )
}
