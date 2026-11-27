import { useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { ApiError, apiDelete } from '../lib/api'
import { Button, ConfirmDialog } from './ui'

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
      <Button
        tone="red"
        size={compact ? 'sm' : 'md'}
        aria-label={compact ? `Delete mission ${name}` : undefined}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="w-4 h-4" aria-hidden /> Delete
      </Button>
      {open && (
        <ConfirmDialog title={`Delete ${name}?`} icon={<Trash2 className="w-5 h-5 text-red-400" />}
          confirmLabel="Delete" workingLabel="Delete" tone="red" working={busy} error={error}
          onCancel={close} onConfirm={confirm}>
          <p className="text-sm text-gray-400">
            The mission <span className="font-mono text-white">{name}</span> is removed. Its chains and ephemeral
            knights are cleaned up according to its cleanup policy.
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
