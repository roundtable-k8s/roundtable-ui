import { useRef, useState } from 'react'
import { Link as RouterLink } from 'react-router-dom'
import { Play } from 'lucide-react'
import { useTaskPoller } from '../hooks/useTaskPoller'
import { apiPost } from '../lib/api'
import { SubmissionKey } from '../lib/submissionKey'
import { sanitizeText } from '../lib/untrusted'

const POLL_MS = 3000

/** Run record returned by the gateway (POST /v1/chains/{name}/runs). */
interface ChainRun {
  run: string
  namespace: string
  phase?: string
  done?: boolean
}

/**
 * "Run now" for a Chain the gateway can run (labelled
 * ai.roundtable.io/invokable=true): optional input, starts a run through the
 * dashboard API and links to the run copy, which shows up on this page.
 */
export function RunNow({ chain, namespace }: { chain: string; namespace: string }) {
  const [input, setInput] = useState('')
  const [starting, setStarting] = useState(false)
  const submission = useRef(new SubmissionKey())
  const [run, setRun] = useState<ChainRun | null>(null)
  const [error, setError] = useState('')

  // Follow the run until it finishes; errors are swallowed and retried forever
  const runNs = run?.namespace ?? namespace
  useTaskPoller<ChainRun, ChainRun>({
    items: run ? [run] : [],
    idOf: (r) => r.run,
    isDone: (r) => !!r.done,
    fetchUrl: (r) => `/api/chains/runs/${encodeURIComponent(runNs)}/${encodeURIComponent(r.run)}`,
    onUpdate: (_id, r) => setRun((prev) => (prev && prev.run === r.run ? { ...prev, ...r } : prev)),
    maxFailures: Infinity,
    intervalMs: POLL_MS,
  })

  const start = async () => {
    if (starting) return
    setStarting(true)
    setError('')
    try {
      const body: { input?: string; namespace?: string } = { namespace }
      if (input.trim()) body.input = input
      const key = submission.current.next(JSON.stringify([chain, body]))
      setRun(await apiPost<ChainRun>(`/api/chains/${encodeURIComponent(chain)}/run`, body, { headers: { 'Idempotency-Key': key } }))
      submission.current.settle()
    } catch (e) {
      submission.current.settle(e)
      setError(e instanceof Error ? e.message : 'Failed to start the run')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="mt-3 mb-3 flex flex-wrap items-start gap-2" data-testid="run-now">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Input (optional)"
        aria-label={`Input for ${chain}`}
        className="flex-1 min-w-48 bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:border-roundtable-gold/50 focus:outline-none"
      />
      <button
        onClick={start}
        disabled={starting}
        className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-roundtable-gold/20 hover:bg-roundtable-gold/30 border border-roundtable-gold/30 rounded-lg text-roundtable-gold text-sm font-medium transition-colors disabled:opacity-50"
      >
        <Play className="w-3.5 h-3.5" />
        {starting ? 'Starting…' : 'Run now'}
      </button>
      {run && (
        <span className="text-sm text-gray-400 self-center">
          Started{' '}
          <RouterLink to={`/chains?chain=${encodeURIComponent(run.run)}`} className="text-roundtable-gold hover:underline font-mono">
            {sanitizeText(run.run)}
          </RouterLink>
          {run.phase && <span data-testid="run-phase" className="ml-2 text-gray-500">{sanitizeText(run.phase)}</span>}
        </span>
      )}
      {error && <span role="alert" className="text-sm text-red-400 self-center">{sanitizeText(error)}</span>}
    </div>
  )
}
