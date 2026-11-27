import { useEffect, useRef, useState } from 'react'
import { Camera } from 'lucide-react'
import { apiPost } from '../lib/api'
import { usePolledFetch } from '../hooks/usePolledFetch'
import { sanitizeText } from '../lib/untrusted'
import type { Knight } from '../hooks/useFleet'

const POLL_MS = 3000
const WATCH_MS = 60_000

interface SnapshotAnswer {
  expectedName?: string
  note?: string
}

/** One plain sentence for the gateway's refusals; other errors keep their text. */
export function snapshotErrorMessage(e: unknown): string {
  const status = (e as { status?: unknown } | null)?.status
  switch (status) {
    case 409: return 'A snapshot was requested a moment ago. Try again shortly.'
    case 422: return 'Only knights with a pvc workspace can be snapshotted; this one uses an ephemeral workspace.'
    case 404: return 'Workspace snapshots are not enabled on this gateway.'
    default: return e instanceof Error && e.message ? e.message : 'Failed to request a snapshot'
  }
}

const conditionKey = (c?: Knight['workspaceSnapshotsCondition']) => (c ? `${c.status}|${c.reason ?? ''}` : '')

/** Refreshes the knight detail every 3 s while mounted; the parent unmounts it to stop. */
function DetailPoller({ url, onDetail }: { url: string; onDetail: (k: Knight) => void }) {
  const { data, updatedAt } = usePolledFetch<Knight | null>(url, POLL_MS, null)
  useEffect(() => {
    if (data && updatedAt) onDetail(data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt])
  return null
}

/**
 * "Take snapshot": asks the gateway for a workspace snapshot and, after the
 * 202, follows the knight detail (3 s, up to 60 s) until a new snapshot name
 * appears or the WorkspaceSnapshots condition changes.
 */
export function SnapshotButton({ name, namespace, knight, onDetail }: {
  name: string
  namespace?: string
  /** Latest knight detail; supplies the snapshot names and condition to compare against. */
  knight: Knight
  onDetail: (k: Knight) => void
}) {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [expected, setExpected] = useState('')
  const [watching, setWatching] = useState(false)
  const baseline = useRef<{ names: Set<string>; cond: string }>({ names: new Set(), cond: '' })

  const names = (knight.workspaceSnapshots ?? []).map((s) => s.name)
  const cond = conditionKey(knight.workspaceSnapshotsCondition)

  // Stop once something changed relative to the click
  useEffect(() => {
    if (!watching) return
    const appeared = names.some((n) => !baseline.current.names.has(n))
    if (appeared || cond !== baseline.current.cond) setWatching(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, names.join('\n'), cond])

  // ...or after 60 s
  useEffect(() => {
    if (!watching) return
    const t = setTimeout(() => setWatching(false), WATCH_MS)
    return () => clearTimeout(t)
  }, [watching])

  // Another knight: drop the previous one's state
  useEffect(() => {
    setWatching(false); setMessage(''); setError(''); setExpected('')
  }, [name, namespace])

  const take = async () => {
    if (pending) return
    setPending(true)
    setMessage(''); setError(''); setExpected('')
    try {
      const qs = namespace ? `?namespace=${encodeURIComponent(namespace)}` : ''
      const ans = await apiPost<SnapshotAnswer>(`/api/knights/${encodeURIComponent(name)}/snapshot${qs}`, {})
      baseline.current = { names: new Set(names), cond }
      setExpected(ans?.expectedName ?? '')
      setMessage(ans?.note ?? '')
      setWatching(true)
    } catch (e) {
      setError(snapshotErrorMessage(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <span className="inline-flex items-center gap-2 font-normal" data-testid="snapshot-button">
      <button
        type="button"
        onClick={take}
        disabled={pending}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-roundtable-gold/20 hover:bg-roundtable-gold/30 border border-roundtable-gold/30 rounded-lg text-roundtable-gold text-xs font-medium transition-colors disabled:opacity-50"
      >
        <Camera className="w-3.5 h-3.5" />
        {pending ? 'Requesting…' : 'Take snapshot'}
      </button>
      {expected && watching && (
        <span className="text-xs text-gray-400">
          Expected: <span className="font-mono">{sanitizeText(expected)}</span> (Pending)
        </span>
      )}
      {message && <span className="text-xs text-gray-400">{sanitizeText(message)}</span>}
      {error && <span role="alert" className="text-xs text-red-400">{sanitizeText(error)}</span>}
      {watching && <DetailPoller url={`/api/fleet/${encodeURIComponent(name)}`} onDetail={onDetail} />}
    </span>
  )
}
