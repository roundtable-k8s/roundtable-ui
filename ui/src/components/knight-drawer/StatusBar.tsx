import type { Knight } from '../../hooks/useFleet'
import { formatAge } from '../../lib/format'

function statusLabel(k: Knight): string {
  switch (k.status) {
    case 'scaled-to-zero': return 'Scaled to zero'
    case 'starting': return 'Starting'
    case 'busy': return 'Busy'
    case 'online': return 'Online'
    case 'offline': return 'Offline'
    default: return k.ready ? 'Online' : 'Offline'
  }
}

export function StatusBar({ knight }: { knight: Knight }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className={`w-2.5 h-2.5 rounded-full ${knight.status === 'scaled-to-zero' ? 'bg-gray-500' : knight.status === 'starting' ? 'bg-amber-500' : knight.ready ? 'bg-green-500' : 'bg-red-500'} animate-pulse`} />
      <span className="text-sm text-gray-300">{statusLabel(knight)}</span>
      <span className="text-xs text-gray-500">•</span>
      <span className="text-xs text-gray-500">{formatAge(knight.ready ? (knight.startedAt ?? knight.createdAt) : knight.createdAt, knight.age)} {knight.ready ? 'uptime' : 'age'}</span>
      <span className="text-xs text-gray-500">•</span>
      <span className="text-xs text-gray-500">{knight.restarts} restarts</span>
      <span className="text-xs text-gray-500">•</span>
      <span className="text-xs text-gray-400 font-mono">{knight.name}</span>
    </div>
  )
}
