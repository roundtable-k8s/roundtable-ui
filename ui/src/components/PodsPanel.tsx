import { Link } from 'react-router-dom'
import type { Knight } from '../hooks/useFleet'
import { formatCpu, formatMemory, usageFraction, podState } from '../lib/pods'
import { formatAge, formatRelativeTime } from '../lib/format'

function Bar({ usage, limit, request, label }: { usage?: string; limit?: string; request?: string; label: string }) {
  const f = usageFraction(usage, limit, request)
  if (f === null) return <span className="text-gray-600">—</span>
  const pct = Math.min(f * 100, 100)
  const color = f >= 0.9 ? 'bg-red-500' : f >= 0.7 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div role="progressbar" aria-label={label} aria-valuenow={Math.round(f * 100)} className="w-16 h-1.5 bg-roundtable-navy rounded">
      <div className={`h-full rounded ${color}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Scaling summary + per-pod table for the knight drawer's Pods section (#182). */
export function PodsPanel({ knight }: { knight: Knight }) {
  const pods = knight.pods ?? []
  const sc = knight.scaling
  const metricsMissing = pods.length > 0 && pods.every((p) => !p.cpu && !p.memory)
  const name = encodeURIComponent(knight.name)
  return (
    <div className="space-y-2" data-testid="pods-panel">
      {sc && (
        <div className="bg-roundtable-slate rounded-lg p-3 text-xs text-gray-300 flex flex-wrap gap-x-4 gap-y-1">
          <span>{sc.autoscaled ? 'Autoscaled' : 'Fixed replicas'}</span>
          <span>min {sc.minReplicas} / max {sc.maxReplicas}</span>
          <span>desired {sc.desiredReplicas ?? '—'}</span>
          <span>current {sc.currentReplicas} · ready {sc.readyReplicas}</span>
          {sc.lastScaleTime && <span>last scaled {formatRelativeTime(sc.lastScaleTime)}</span>}
        </div>
      )}
      {pods.length === 0 ? (
        <p className="text-xs text-gray-500">
          {knight.status === 'scaled-to-zero' ? 'Scaled to zero — no pods running.' : 'No pods.'}
        </p>
      ) : (
        <div className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-roundtable-steel/50 text-left text-gray-500">
                <th className="px-2 py-2 font-medium">Pod</th>
                <th className="px-2 py-2 font-medium">Node</th>
                <th className="px-2 py-2 font-medium">CPU</th>
                <th className="px-2 py-2 font-medium">Memory</th>
                <th className="px-2 py-2 font-medium">Restarts</th>
                <th className="px-2 py-2 font-medium">Links</th>
              </tr>
            </thead>
            <tbody>
              {pods.map((p) => (
                <tr key={p.name} data-state={podState(p)} className="border-b border-roundtable-steel/30 last:border-0 align-top">
                  <td className="px-2 py-2 font-mono text-gray-300">
                    <div className="truncate max-w-[140px]" title={p.name}>{p.name}</div>
                    <div className="text-gray-500">
                      {p.draining ? <span className="text-orange-400">Draining</span> : p.ready ? 'Ready' : p.phase} · {formatAge(p.createdAt, p.age)}
                    </div>
                  </td>
                  <td className="px-2 py-2 text-gray-400 font-mono">{p.node || '—'}</td>
                  <td className="px-2 py-2">
                    <div className="text-gray-300 font-mono">{formatCpu(p.cpu)}{p.cpuLimit ? ` / ${formatCpu(p.cpuLimit)}` : ''}</div>
                    <Bar usage={p.cpu} limit={p.cpuLimit} request={p.cpuRequest} label={`${p.name} CPU`} />
                  </td>
                  <td className="px-2 py-2">
                    <div className="text-gray-300 font-mono">{formatMemory(p.memory)}{p.memoryLimit ? ` / ${formatMemory(p.memoryLimit)}` : ''}</div>
                    <Bar usage={p.memory} limit={p.memoryLimit} request={p.memoryRequest} label={`${p.name} memory`} />
                  </td>
                  <td className="px-2 py-2 font-mono text-gray-300">
                    {p.restarts}
                    {p.lastTerminationReason && (
                      <div className={p.lastTerminationReason === 'OOMKilled' ? 'text-red-400' : 'text-gray-500'}>{p.lastTerminationReason}</div>
                    )}
                  </td>
                  <td className="px-2 py-2 space-y-1">
                    <Link className="block text-roundtable-gold hover:underline" to={`/sessions?knight=${name}&pod=${encodeURIComponent(p.name)}`}>Session</Link>
                    <Link className="block text-roundtable-gold hover:underline" to={`/running?knight=${name}`}>Tasks</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {metricsMissing && (
        <p className="text-xs text-gray-500">CPU/memory usage unavailable — metrics-server may not be installed.</p>
      )}
    </div>
  )
}
