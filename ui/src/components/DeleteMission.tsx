import { useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { ApiError, apiDelete } from '../lib/api'
import { Modal } from './ui'

const btn = 'inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50'

/**
 * Delete button plus a confirmation dialog for one mission. A 404 counts as
 * already deleted; any other failure is shown in the dialog, which stays open.
 */
export function DeleteMission({ name, onDeleted, compact = false }: {
  name: string
  onDeleted: () => void
  /** Smaller button for use inside a card. */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // A ref, not state: a second click in the same tick must not send a second request.
  const inFlight = useRef(false)

  const close = () => { if (!inFlight.current) { setOpen(false); setError('') } }

  const confirm = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await apiDelete('/api/missions/' + encodeURIComponent(name))
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        setError(e instanceof Error && e.message ? e.message : 'Delete failed')
        inFlight.current = false
        setBusy(false)
        return
      }
    }
    inFlight.current = false
    setBusy(false)
    setOpen(false)
    onDeleted()
  }

  return (
    // The card this may sit in is clickable; keep clicks here from navigating.
    <div className="contents" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`${btn} border-red-500/30 text-red-300 hover:bg-red-500/10${compact ? ' px-2 py-0.5 text-xs' : ''}`}
        aria-label={compact ? `Delete mission ${name}` : undefined}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="w-4 h-4" aria-hidden /> Delete
      </button>
      {open && (
        <Modal title={`Delete ${name}?`} icon={<Trash2 className="w-5 h-5 text-red-400" />} onClose={close}>
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-400">
              The mission <span className="font-mono text-white">{name}</span> is removed. Its chains and ephemeral
              knights are cleaned up according to its cleanup policy.
            </p>
            {error && <p role="alert" className="text-sm text-red-400 break-words">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={`${btn} border-roundtable-steel text-gray-300`} disabled={busy} onClick={close}>Cancel</button>
              <button type="button" className={`${btn} border-red-500/30 bg-red-500/10 text-red-300`} disabled={busy} onClick={confirm}>Delete</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
