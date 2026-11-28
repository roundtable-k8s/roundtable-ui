import { apiPost } from '../../lib/api'
import { useState } from 'react'
import { Square } from 'lucide-react'
import { until } from '../../lib/format'
import type { Chain } from '../../lib/types'
import { sanitizeText } from '../../lib/untrusted'

/** "Cancel run" for a gateway-started run copy that has not finished. The
 *  gateway answers 404/409 for runs it cannot cancel; the message is shown. */
export function CancelRun({ chain }: { chain: Chain }) {
  const [cancelling, setCancelling] = useState(false)
  // Phase at the time cancel was requested; the button stays disabled until it changes.
  const [requestedAt, setRequestedAt] = useState<string | null>(null)
  const [error, setError] = useState('')
  const requested = requestedAt !== null && requestedAt === chain.phase
  const cancel = async () => {
    if (!window.confirm(`Cancel run ${chain.name}? Unfinished steps fail; tasks already sent to knights are not recalled.`)) return
    setCancelling(true)
    setError('')
    try {
      await apiPost(`/api/chains/runs/${encodeURIComponent(chain.namespace)}/${encodeURIComponent(chain.name)}/cancel`, {})
      setRequestedAt(chain.phase)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to cancel the run')
    } finally {
      setCancelling(false)
    }
  }
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="cancel-run">
      <button
        onClick={cancel}
        disabled={cancelling || requested}
        className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 rounded-lg text-red-400 text-sm font-medium transition-colors disabled:opacity-50"
      >
        <Square className="w-3.5 h-3.5" />
        {cancelling ? 'Cancelling…' : 'Cancel run'}
      </button>
      {requested && <span role="status" className="text-sm text-gray-400">Cancel requested</span>}
      {error && <span role="alert" className="text-sm text-red-400">{sanitizeText(error)}</span>}
    </div>
  )
}
