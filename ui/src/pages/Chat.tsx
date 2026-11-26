import { useVisibleInterval } from '../hooks/useVisibleInterval'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MessageSquare, Send, Activity } from 'lucide-react'
import { apiGet, apiPost, ApiError } from '../lib/api'
import { PageHeader, EmptyState, ErrorBanner } from '../components/ui'
import { UntrustedText } from '../components/UntrustedText'
import { TaskActivityPanel } from '../components/TaskActivityPanel'
import { formatCost } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { isFinalStatus, mergeTurn, parseKnightNames, type ChatTask, type ChatTurn } from '../lib/chat'

const POLL_MS = 2000

export function ChatPage() {
  const [params, setParams] = useSearchParams()
  const knight = params.get('knight') ?? ''
  const runId = params.get('run') ?? ''
  const [knights, setKnights] = useState<string[]>([])
  const [knightsError, setKnightsError] = useState<string | null>(null)
  const [turns, setTurns] = useState<ChatTurn[]>([])
  const [message, setMessage] = useState('')
  const [model, setModel] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activityTask, setActivityTask] = useState<string | null>(null)
  const nextId = useRef(1)

  useEffect(() => {
    apiGet<unknown>('/api/chat/knights')
      .then((d) => setKnights(parseKnightNames(d)))
      .catch((e: Error) => setKnightsError(e.message))
  }, [])

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
    try {
      const t = await apiPost<ChatTask>(`/api/chat/${encodeURIComponent(knight)}`, {
        message: text,
        ...(runId ? { runId } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      })
      setTurns((ts) => [...ts, mergeTurn({ id, message: text, status: 'pending' }, t)])
      if (t.runId && t.runId !== runId) update({ run: t.runId })
      setMessage('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  function pick(name: string) {
    setTurns([])
    setActivityTask(null)
    update({ knight: name || null, run: null })
  }

  const running = turns.some((t) => !isFinalStatus(t.status))

  return (
    <div className="space-y-4 max-w-3xl">
      <PageHeader icon={MessageSquare} title="Chat" subtitle="Talk to one knight through the gateway; every message in a conversation shares one run." />
      {knightsError && <ErrorBanner>{knightsError}</ErrorBanner>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-400">
          Knight
          <select
            aria-label="Knight"
            value={knight}
            onChange={(e) => pick(e.target.value)}
            className="block mt-1 bg-roundtable-slate border border-roundtable-steel rounded px-3 py-2 text-gray-200"
          >
            <option value="">Select a knight…</option>
            {knights.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        {runId && (
          <>
            <span className="text-xs text-gray-500">Run <code>{sanitizeText(runId)}</code></span>
            <button type="button" className="text-xs text-roundtable-gold hover:underline" onClick={() => pick(knight)}>
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
                    <UntrustedText text={t.error || 'Task failed'} as="p" className="text-sm text-red-400 whitespace-pre-wrap break-words" />
                  ) : t.status === 'succeeded' ? (
                    <UntrustedText text={t.output ?? ''} as="p" className="text-sm text-gray-200 whitespace-pre-wrap break-words" />
                  ) : (
                    <p role="status" className="text-sm text-blue-400">{knight} is working…</p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                    {t.model && <span>Model {sanitizeText(t.model)}</span>}
                    {t.costUsd !== undefined && <span>{formatCost(t.costUsd)}</span>}
                    {t.toolCalls !== undefined && <span>{t.toolCalls} tool calls</span>}
                    {t.taskId && (
                      <button type="button" className="inline-flex items-center gap-1 text-roundtable-gold hover:underline"
                        onClick={() => setActivityTask(t.taskId!)}>
                        <Activity className="w-3 h-3" /> Activity
                      </button>
                    )}
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
