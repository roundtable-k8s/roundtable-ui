import { ShieldCheck, ShieldAlert, ShieldOff, ShieldQuestion } from 'lucide-react'
import type { KnightIsolation } from '../hooks/useFleet'
import { ISOLATION_CLASS, ISOLATION_LABEL, isolationTooltip } from '../lib/isolation'

const ICON = {
  isolated: ShieldCheck,
  'opted-out': ShieldOff,
  'not-enforced': ShieldAlert,
  unknown: ShieldQuestion,
} as const

/** Isolated / opted out / not enforced badge with the reason on hover (#269). */
export function IsolationBadge({ isolation }: { isolation: KnightIsolation }) {
  const Icon = ICON[isolation.state] ?? ShieldQuestion
  const label = ISOLATION_LABEL[isolation.state] ?? isolation.state
  return (
    <span
      data-testid="isolation-badge"
      data-state={isolation.state}
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${ISOLATION_CLASS[isolation.state] ?? ISOLATION_CLASS.unknown}`}
      title={isolationTooltip(isolation)}
    >
      <Icon className="w-3 h-3" aria-hidden />
      {label}
    </span>
  )
}
