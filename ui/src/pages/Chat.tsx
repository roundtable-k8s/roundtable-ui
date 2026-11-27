import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { MessageSquare, Send, Activity } from 'lucide-react'
import { useVisibleInterval } from '../hooks/useVisibleInterval'
import { apiGet, apiPost, ApiError } from '../lib/api'
import { SubmissionKey } from '../lib/submissionKey'
import { PageHeader, EmptyState, ErrorBanner } from '../components/ui'
import { UntrustedText } from '../components/UntrustedText'
import { TaskActivityPanel } from '../components/TaskActivityPanel'
import { TraceLink } from '../components/TraceLink'
import { formatMsLadder } from '../lib/format'
import { tokensText } from '../lib/cost'
import { CostTag } from '../components/CostTag'
import { sanitizeText } from '../lib/untrusted'
import { isFinalStatus, mergeTurn, knightKey, parseKnights, type ChatKnight, type ChatTask, type ChatTurn } from '../lib/chat'

const POLL_MS = 2000
/** After this long without a result the turn is flagged and Send is re-enabled. */
export const STALE_TURN_MS = 2 * 60 * 1000

export function ChatPage() {
  const [params, setParams] = useSearchParams()
  const knight = params.get('knight') ?? ''
  const namespace = params.get('ns') ?? ''
  const runId = params.get('run') ?? ''
  const [knights, setKnights] = useState<ChatKnight[]>([])
  const [knightsError, setKnightsError] = useState<string | null>(null)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [message, setMessage] = useState('')
  const [model, setModel] = useState('')
  const [sending, setSending] = useState(false)
  const submission = useRef(new SubmissionKey())
  const [error, setError] = useState<string | null>(null)
  const [activityTask, setActivityTask] = useState<string | null>(null)
  const nextId = useRef(1)
  // Bumped whenever the conversation is reset, so a late send response can tell it is stale.
  const generation = useRef(0)
  const [staleIds, setStaleIds] = useState<Set<number>>(new Set())
  const staleTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>())
  const [knightsAttempt, setKnightsAttempt] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    setKnightsError(null)
    apiGet<unknown>('/api/chat/knights', { signal: ctrl.signal })
      .then((d) => setKnights(parseKnights(d)))
      .catch((e: Error) => { if (!ctrl.signal.aborted) setKnightsError(e.message) })
    return () => ctrl.abort()
  }, [knightsAttempt])

  useEffect(() => {
    const timers = staleTimers.current
    return () => { timers.forEach(clearTimeout); timers.clear() }
  }, [])

  // Flag each turn that is still working after STALE_TURN_MS.
  useEffect(() => {
    for (const t of turns) {
      if (isFinalStatus(t.status)) {
        const timer = staleTimers.current.get(t.id)
        if (timer !== undefined) { clearTimeout(timer); staleTimers.current.delete(t.id) }
        continue
      }
      if (staleTimers.current.has(t.id)) continue
      staleTimers.current.set(t.id, setTimeout(() => {
        setStaleIds((s) => new Set(s).add(t.id))
      }, STALE_TURN_MS))
    }
  }, [turns])

  const update = useCallback((next: Record<string, string | null>) => {
    setParams((prev) => {
      const p = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(next)) {
        if (v) p.set(k, v)
        else p.delete(k)
      }
      return p
    }, { replace: true })
  }, [setParams])

  // Poll every pending turn until the gateway reports a final status.
  const pendingIds = turns.filter((t) => t.taskId && !isFinalStatus(t.status)).map((t) => t.taskId).join(',')
  useVisibleInterval(
    (signal) =>
      Promise.all(pendingIds.split(',').map((id) =>
        apiGet<ChatTask>(`/api/chat/tasks/${encodeURIComponent(id)}`, { signal })
          .then((t) => setTurns((ts) => ts.map((x) => (x.taskId === id ? mergeTurn(x, t) : x))))
          .catch((e: unknown) => {
            // A missing task will never finish; stop polling and unblock Send.
            if (e instanceof ApiError && e.status === 404) {
              setTurns((ts) => ts.map((x) => (x.taskId === id ? { ...x, status: 'failed', error: 'Task not found on the gateway' } : x)))
            }
            // other errors are transient: next tick retries
          }),
      )),
    POLL_MS,
    !!pendingIds,
    { key: pendingIds },
  )

  async function send() {
    const text = message.trim()
    if (!knight || !text || sending) return
    setSending(true)
    setError(null)
    const id = nextId.current++
    const gen = generation.current
    try {
      const payload = {
        message: text,
        ...(namespace ? { namespace } : {}),
        ...(runId ? { runId } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      }
      const key = submission.current.next(JSON.stringify([knight, payload]))
      const t = await apiPost<ChatTask>(`/api/chat/${encodeURIComponent(knight)}`, payload, { headers: { 'Idempotency-Key': key } })
      submission.current.settle()
      // The user switched knight (or started a new conversation) while this was in flight.
      if (gen !== generation.current) return
      setTurns((ts) => [...ts, mergeTurn({ id, message: text, status: 'pending' }, t)])
      if (t.runId && t.runId !== runId) update({ run: t.runId })
      setMessage('')
    } catch (e) {
      submission.current.settle(e)
      if (gen === generation.current) setError(e instanceof Error ? e.message : 'Send failed')
    } finally {
      if (gen === generation.current) setSending(false)
    }
  }

  function pick(key: string) {
    const k = knights.find((x) => knightKey(x) === key)
    generation.current++
    staleTimers.current.forEach(clearTimeout)
    staleTimers.current.clear()
    setStaleIds(new Set())
    setTurns([])
    setSending(false)
    setError(null)
    setActivityTask(null)
    update({ knight: k?.name ?? null, ns: k?.namespace ?? null, run: null })
  }

  const nameCount = new Map<string, number>()
  for (const k of knights) nameCount.set(k.name, (nameCount.get(k.name) ?? 0) + 1)
  // Links without `ns` resolve to the only knight with that name.
  const sameName = namespace ? [] : knights.filter((k) => k.name === knight)
  const resolved = sameName.length === 1 ? sameName[0] : undefined
  const ambiguous = !!knight && !namespace && sameName.length > 1
  const selectedKey = ambiguous ? '' : resolved ? knightKey(resolved) : knightKey({ name: knight, namespace: namespace || undefined })
  const resolvedNs = resolved?.namespace
  useEffect(() => {
    if (resolvedNs) update({ ns: resolvedNs })
  }, [resolvedNs, update])

  // A stale turn no longer blocks Send; it keeps polling in the background.
  const running = turns.some((t) => !isFinalStatus(t.status) && !staleIds.has(t.id))

  return (
    <div className="space-y-4 max-w-3xl">
      <PageHeader icon={MessageSquare} title="Chat" subtitle="Talk to one knight through the gateway; every message in a conversation shares one run." />
      {knightsError && (
        <ErrorBanner>
          {knightsError}{' '}
          <button type="button" className="underline" onClick={() => setKnightsAttempt((n) => n + 1)}>Retry</button>
        </ErrorBanner>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-400">
          Knight
          <select
            aria-label="Knight"
            value={selectedKey}
            onChange={(e) => pick(e.target.value)}
            className="block mt-1 bg-roundtable-slate border border-roundtable-steel rounded px-3 py-2 text-gray-200"
          >
            <option value="">{ambiguous ? 'Pick the namespace' : 'Select a knight…'}</option>
            {knights.map((k) => (
              <option key={knightKey(k)} value={knightKey(k)}>
                {(nameCount.get(k.name) ?? 0) > 1 ? knightKey(k) : k.name}
              </option>
            ))}
          </select>
        </label>
        {runId && (
          <>
            <span className="text-xs text-gray-500">Run <code>{sanitizeText(runId)}</code></span>
            <button type="button" className="text-xs text-roundtable-gold hover:underline" onClick={() => pick(selectedKey)}>
              New conversation
            </button>
          </>
        )}
      </div>

      {!knight ? (
        <EmptyState icon={MessageSquare} title="Pick a knight to start" />
      ) : (
        <>
          {runId && turns.length === 0 && (
            <p className="text-xs text-gray-500">Continuing run <code>{sanitizeText(runId)}</code>; earlier turns are not shown here.</p>
          )}
          <ol className="space-y-3" aria-label="Conversation">
            {turns.map((t) => (
              <li key={t.id} data-testid="chat-turn" className="space-y-2">
                <div className="bg-roundtable-steel/40 rounded-lg p-3 ml-8">
                  <UntrustedText text={t.message} as="p" className="text-sm text-gray-200 whitespace-pre-wrap break-words" />
                </div>
                <div className="bg-roundtable-slate border border-roundtable-steel rounded-lg p-3 mr-8">
                  {t.status === 'failed' ? (
                    <>
                      <UntrustedText text={t.error || 'Task failed'} as="p" className="text-sm text-red-400 whitespace-pre-wrap break-words" />
                      {t.usageLimited && <p className="mt-1 text-xs text-yellow-400">Usage limit reached</p>}
                    </>
                  ) : t.status === 'succeeded' ? (
                    <UntrustedText text={t.output ?? ''} as="p" className="text-sm text-gray-200 whitespace-pre-wrap break-words" />
                  ) : (
                    <p role="status" className="text-sm text-blue-400">{knight} is working…</p>
                  )}
                  {!isFinalStatus(t.status) && staleIds.has(t.id) && (
                    <p className="mt-1 text-xs text-yellow-400">
                      Still waiting. The knight may be offline, check <Link to="/failed" className="underline">Failed &amp; lost</Link>.
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                    {t.model && <span>Model {sanitizeText(t.model)}</span>}
                    {t.cost !== undefined && <CostTag costUSD={String(t.cost)} notional={t.billing === 'subscription'} />}
                    {t.tokens && <span>{tokensText(t.tokens)}</span>}
                    {t.turns !== undefined && <span>{t.turns} {t.turns === 1 ? 'turn' : 'turns'}</span>}
                    {t.toolCalls !== undefined && <span>{t.toolCalls} tool calls</span>}
                    {t.durationMs !== undefined && <span>{formatMsLadder(t.durationMs)}</span>}
                    {t.taskId && (
                      <button type="button" className="inline-flex items-center gap-1 text-roundtable-gold hover:underline"
                        onClick={() => setActivityTask(t.taskId!)}>
                        <Activity className="w-3 h-3" /> Activity
                      </button>
                    )}
                    <TraceLink traceId={t.traceId} size="xs" />
                  </div>
                </div>
              </li>
            ))}
          </ol>
          {error && <ErrorBanner>{error}</ErrorBanner>}
          <form
            className="space-y-2"
            onSubmit={(e) => { e.preventDefault(); void send() }}
          >
            <textarea
              aria-label="Message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={10000}
              rows={3}
              className="w-full bg-roundtable-slate border border-roundtable-steel rounded px-3 py-2 text-gray-200"
              placeholder={`Message ${knight}…`}
            />
            <div className="flex items-center gap-3">
              <input
                aria-label="Model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Model (optional)"
                className="bg-roundtable-slate border border-roundtable-steel rounded px-3 py-2 text-sm text-gray-200"
              />
              <button
                type="submit"
                disabled={sending || running || !message.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded bg-roundtable-gold/20 text-roundtable-gold disabled:opacity-50"
              >
                <Send className="w-4 h-4" /> Send
              </button>
            </div>
          </form>
        </>
      )}
      {activityTask && <TaskActivityPanel taskId={activityTask} hint={{ knight, runId }} onClose={() => setActivityTask(null)} />}
    </div>
  )
}
