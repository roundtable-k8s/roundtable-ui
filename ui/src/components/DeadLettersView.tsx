import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Skull, RotateCcw } from 'lucide-react'
import { Drawer, Modal, EmptyState, ErrorBanner, Spinner } from './ui'
import { UntrustedText } from './UntrustedText'
import { formatTimestampOrDate } from '../lib/format'
import { sanitizeText } from '../lib/untrusted'
import { errorExcerpt, deadLetterTime, isChainOwned, type DeadLetter, type RetryResult } from '../lib/deadLetters'

interface Props {
  entries: DeadLetter[]
  loading?: boolean
  error?: string | null
  /** Retries the entry; resolves with the new task. force = retry outside the chain. */
  onRetry: (entry: DeadLetter, force: boolean) => Promise<RetryResult>
  /** Loads one entry including its original task payload. */
  onLoadDetail: (entry: DeadLetter) => Promise<DeadLetter>
}

const stateStyle: Record<string, string> = {
  open: 'bg-red-500/20 text-red-400',
  retried: 'bg-blue-500/20 text-blue-400',
  resolved: 'bg-gray-500/20 text-gray-400',
}

const entryKey = (d: DeadLetter) => `${d.table ?? ''}/${d.taskId}`

export function DeadLettersView({ entries, loading, error, onRetry, onLoadDetail }: Props) {
  const [knight, setKnight] = useState('')
  const [reason, setReason] = useState('')
  const [selected, setSelected] = useState<DeadLetter | null>(null)
  const [detail, setDetail] = useState<DeadLetter | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<DeadLetter | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [retried, setRetried] = useState<Record<string, RetryResult>>({})
  const [retryError, setRetryError] = useState<string | null>(null)

  const knights = useMemo(() => [...new Set(entries.map((e) => e.knight))].sort(), [entries])
  const reasons = useMemo(() => [...new Set(entries.map((e) => e.reason))].sort(), [entries])
  const rows = entries.filter((e) => (!knight || e.knight === knight) && (!reason || e.reason === reason))

  const open = (e: DeadLetter) => {
    setSelected(e)
    setDetail(null)
    setDetailError(null)
    onLoadDetail(e).then(setDetail).catch((err) => setDetailError(err instanceof Error ? err.message : 'failed to load'))
  }

  const retry = async (e: DeadLetter, force: boolean) => {
    const key = entryKey(e)
    if (pending === key) return
    setPending(key)
    setRetryError(null)
    try {
      const res = await onRetry(e, force)
      setRetried((r) => ({ ...r, [key]: res }))
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'retry failed')
    } finally {
      setPending(null)
    }
  }

  const retryButton = (e: DeadLetter) => {
    const key = entryKey(e)
    const chain = isChainOwned(e)
    const done = retried[key]
    if (done) {
      return <Link className="text-roundtable-gold hover:underline text-sm" to={`/running?task=${encodeURIComponent(done.taskId)}`}>Retried as {done.taskId}</Link>
    }
    if (e.state !== 'open') return null
    return (
      <button
        type="button"
        disabled={pending === key}
        onClick={(ev) => { ev.stopPropagation(); chain ? setConfirming(e) : retry(e, false) }}
        className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-sm bg-roundtable-gold/10 text-roundtable-gold border border-roundtable-gold/30 hover:bg-roundtable-gold/20 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RotateCcw className="w-3.5 h-3.5" />
        {pending === key ? 'Retrying…' : chain ? 'Retry outside the chain' : 'Retry'}
      </button>
    )
  }

  return (
    <div>
      {error && <div className="mb-4"><ErrorBanner>{error}</ErrorBanner></div>}
      {retryError && <div className="mb-4" role="alert"><ErrorBanner>Retry failed: {retryError}</ErrorBanner></div>}

      <div className="flex gap-4 mb-4">
        <div>
          <label htmlFor="dl-knight" className="text-sm text-gray-400 mb-1 block">Knight</label>
          <select id="dl-knight" value={knight} onChange={(e) => setKnight(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white">
            <option value="">All knights</option>
            {knights.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dl-reason" className="text-sm text-gray-400 mb-1 block">Reason</label>
          <select id="dl-reason" value={reason} onChange={(e) => setReason(e.target.value)}
            className="bg-roundtable-navy border border-roundtable-steel rounded-lg px-3 py-2 text-white">
            <option value="">All reasons</option>
            {reasons.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
      </div>

      {loading && entries.length === 0 ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Skull} title="No failed or lost tasks" sub="Tasks that fail or go missing show up here." />
      ) : (
        <div className="bg-roundtable-slate border border-roundtable-steel rounded-xl overflow-x-auto">
          <table className="w-full text-sm" data-testid="dead-letters">
            <thead>
              <tr className="text-left text-gray-400 border-b border-roundtable-steel">
                <th className="p-3">Time</th><th className="p-3">Knight</th><th className="p-3">Reason</th>
                <th className="p-3">Error</th><th className="p-3">Attempt</th><th className="p-3">Chain / step</th>
                <th className="p-3">State</th><th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={entryKey(e)} data-testid="dead-letter-row" onClick={() => open(e)}
                  className={`border-b border-roundtable-steel/50 cursor-pointer hover:bg-roundtable-steel/30 ${e.state === 'resolved' ? 'opacity-50' : ''}`}>
                  <td className="p-3 whitespace-nowrap text-gray-300">{formatTimestampOrDate(deadLetterTime(e))}</td>
                  <td className="p-3 text-white">{e.knight}</td>
                  <td className="p-3 text-gray-300">{e.reason}</td>
                  <td className="p-3 text-gray-400 max-w-xs truncate">{sanitizeText(errorExcerpt(e.error))}</td>
                  <td className="p-3 text-gray-300">{e.attempt}</td>
                  <td className="p-3 text-gray-300">{e.chainName ? `${e.chainName}${e.stepName ? ` / ${e.stepName}` : ''}` : '—'}</td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${stateStyle[e.state] ?? stateStyle.resolved}`}>{e.state}</span>
                    {e.state === 'resolved' && <div className="text-xs text-gray-500 mt-1">A later success arrived</div>}
                  </td>
                  <td className="p-3 text-right">{retryButton(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <Drawer onClose={() => setSelected(null)}>
          <div className="p-6 space-y-4" role="dialog" aria-label={`Dead letter ${selected.taskId}`}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white break-all">{selected.taskId}</h2>
              <button type="button" onClick={() => setSelected(null)} className="text-gray-400 hover:text-white">Close</button>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm text-gray-300">
              <dt className="text-gray-500">Knight</dt><dd>{selected.knight}</dd>
              <dt className="text-gray-500">Reason</dt><dd>{selected.reason}</dd>
              <dt className="text-gray-500">State</dt><dd>{selected.state}</dd>
              <dt className="text-gray-500">Attempt</dt><dd>{selected.attempt}</dd>
              {selected.chainName && <><dt className="text-gray-500">Chain</dt><dd>{selected.chainName}{selected.stepName ? ` / ${selected.stepName}` : ''}</dd></>}
              {selected.retriedAs && <><dt className="text-gray-500">Retried as</dt><dd><Link className="text-roundtable-gold hover:underline" to={`/running?task=${encodeURIComponent(selected.retriedAs)}`}>{selected.retriedAs}</Link></dd></>}
            </dl>
            {selected.state === 'resolved' && <p className="text-sm text-gray-400">A later success arrived for this task.</p>}
            <div>{retryButton(selected)}</div>
            <h3 className="text-sm text-gray-400">Error</h3>
            <UntrustedText text={detail?.error ?? selected.error ?? '(none)'} className="bg-roundtable-navy rounded-lg p-3 text-xs text-red-300 whitespace-pre-wrap break-words" />
            <h3 className="text-sm text-gray-400">Original task</h3>
            {detailError ? <ErrorBanner>{detailError}</ErrorBanner>
              : !detail ? <Spinner size="sm" />
              : <UntrustedText text={detail.task?.task ?? '(no payload)'} className="bg-roundtable-navy rounded-lg p-3 text-xs text-gray-200 whitespace-pre-wrap break-words" />}
          </div>
        </Drawer>
      )}

      {confirming && (
        <Modal title="Retry outside the chain?" onClose={() => setConfirming(null)}>
          <div className="p-6 space-y-4">
            <p className="text-gray-300 text-sm">
              {confirming.taskId} is a step of chain <b>{confirming.chainName}</b>. Retrying it on its own runs the step again, but the chain does not continue.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirming(null)} className="px-4 py-2 text-gray-400 hover:text-white">Cancel</button>
              <button type="button" onClick={() => { const e = confirming; setConfirming(null); retry(e, true) }}
                className="px-4 py-2 rounded-lg bg-roundtable-gold text-roundtable-navy font-medium">Retry outside the chain</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
