import type { Knight } from '../hooks/useFleet'
import { podState } from '../lib/pods'

const DOT: Record<string, string> = {
  ready: 'bg-green-500',
  starting: 'bg-yellow-500',
  draining: 'bg-orange-500 animate-pulse',
}

/** Replica dots (ready / starting / draining) plus current/max; "scaled to zero" when parked. */
export function ReplicaDots({ knight }: { knight: Knight }) {
  const pods = knight.pods ?? []
  const sc = knight.scaling
  if (pods.length === 0 && !sc) return null
  const max = sc?.maxReplicas || Math.max(pods.length, 1)
  if (pods.length === 0 && knight.status === 'scaled-to-zero') {
    return <div className="text-xs text-gray-400" data-testid="replicas">Scaled to zero · 0/{max}</div>
  }
  return (
    <div className="flex items-center gap-2" data-testid="replicas">
      <div className="flex gap-1">
        {pods.map((p) => (
          <span key={p.name} title={`${p.name} (${podState(p)})`} data-state={podState(p)}
            className={`w-2 h-2 rounded-full ${DOT[podState(p)]}`} />
        ))}
      </div>
      <span className="text-xs text-gray-400 font-mono">{sc?.currentReplicas ?? pods.length}/{max}</span>
    </div>
  )
}
