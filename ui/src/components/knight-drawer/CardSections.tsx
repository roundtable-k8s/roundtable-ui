import type { ReactNode } from 'react'
import { ChevronRight, FileCode, IdCard, Shield, AlertTriangle, Activity, Clock } from 'lucide-react'
import type { KnightIsolation } from '../../hooks/useFleet'
import { IsolationBadge } from '../IsolationBadge'
import { egressHostLabels, optOutSummary } from '../../lib/isolation'
import { sanitizeText } from '../../lib/untrusted'
import { cardLoad, type CardEntry } from '../../lib/cards'

function CardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-sm items-start">
      <span className="text-gray-400 flex-shrink-0">{label}</span>
      <span className="text-right min-w-0">{children}</span>
    </div>
  )
}

/** "Card" section: the knight's agent card, live state and load. */
export function KnightCardSection({ entry, fallbackMax }: { entry: CardEntry; fallbackMax?: number }) {
  const { card, live } = entry
  const rt = card.roundtable
  const load = cardLoad(entry, fallbackMax)
  const state = rt.suspended ? 'Suspended' : live ? 'Live' : 'Not live'
  const stateClass = rt.suspended
    ? 'bg-red-500/10 text-red-400 border-red-500/20'
    : live
      ? 'bg-green-500/10 text-green-400 border-green-500/20'
      : 'bg-gray-500/10 text-gray-400 border-gray-500/20'
  return (
    <div data-testid="knight-card-section">
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <IdCard className="w-4 h-4" />
        Card
      </h3>
      <div className="bg-roundtable-slate rounded-lg p-3 space-y-2">
        {card.description && <p className="text-sm text-gray-300">{sanitizeText(card.description)}</p>}
        <CardRow label="State">
          <span className={`text-xs px-2 py-0.5 rounded-full border ${stateClass}`}>{state}</span>
        </CardRow>
        <CardRow label="Load">
          <span className="text-gray-200 font-mono text-xs">
            {load ? `${load.active} / ${load.max ?? '?'} active` : '—'}
          </span>
        </CardRow>
        {rt.model && (
          <CardRow label="Model">
            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono break-all">{sanitizeText(rt.model)}</span>
          </CardRow>
        )}
        {rt.taskSubject && (
          <CardRow label="Task subject">
            <span className="text-xs text-gray-300 font-mono break-all">{sanitizeText(rt.taskSubject)}</span>
          </CardRow>
        )}
        {rt.tools && rt.tools.length > 0 && (
          <CardRow label="Tools">
            <span className="flex flex-wrap justify-end gap-1">
              {rt.tools.map((t) => (
                <span key={t} className="text-xs px-1.5 py-0.5 rounded bg-roundtable-navy/70 border border-roundtable-steel/50 text-gray-300 font-mono">{sanitizeText(t)}</span>
              ))}
            </span>
          </CardRow>
        )}
      </div>
      {card.skills.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-gray-500">Skills ({card.skills.length})</p>
          {card.skills.map((skill) => (
            <div key={skill.id ?? skill.name} className="bg-roundtable-slate border border-roundtable-steel/50 rounded-lg px-3 py-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-medium text-gray-200 font-mono">{sanitizeText(skill.name)}</span>
                {skill.tags && skill.tags.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {skill.tags.map((tag) => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-300 border border-purple-500/20">{sanitizeText(tag)}</span>
                    ))}
                  </span>
                )}
              </div>
              {skill.description && <p className="text-xs text-gray-400 mt-1">{sanitizeText(skill.description)}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-roundtable-navy/70 border border-roundtable-steel/50 text-gray-300 font-mono break-all">{children}</span>
  )
}

/** Why hostname rules are not enforced, or null when they are (#269). */
function hostnameWarning(iso: KnightIsolation): string | null {
  if (iso.egressOptOut) return 'No egress policy: this knight may reach any host on any port.'
  if (iso.hostnameRulesEnforced) return null
  const er = iso.egressRestricted
  if (er?.reason === 'FQDNPolicyUnavailable') {
    return 'Hostname rules are not enforced: the CiliumNetworkPolicy API is unavailable, so the allowed ports are open to any destination.'
  }
  if (!er) return 'Hostname rules are not enforced: no egress policy applies to this knight.'
  return `Hostname rules are not enforced (${sanitizeText(er.reason)})${er.message ? `: ${sanitizeText(er.message)}` : ''}`
}

/** "Isolation" section: RuntimeClass, opt-out reason and egress allowlist (#269). */
export function KnightIsolationSection({ isolation: iso }: { isolation: KnightIsolation }) {
  const optedOut = iso.state === 'opted-out'
  const warning = hostnameWarning(iso)
  const egress = iso.egress
  const missingService = iso.egressRestricted?.reason === 'ServiceNotFound'
  const optOuts = optOutSummary(iso)
  return (
    <div data-testid="knight-isolation-section">
      <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
        <Shield className="w-4 h-4" />
        Isolation
      </h3>
      <div className={`bg-roundtable-slate rounded-lg p-3 space-y-2 ${optedOut ? 'border border-red-500/40' : ''}`}>
        <CardRow label="State"><IsolationBadge isolation={iso} /></CardRow>
        {optedOut && (
          <div className="text-xs bg-red-500/10 border border-red-500/30 rounded p-2 text-red-300">
            <p className="font-medium">Opted out{optOuts ? ` (${optOuts})` : ''}</p>
            <p className="mt-1">Reason: {sanitizeText(iso.optOutReason || iso.message || 'none given')}</p>
          </div>
        )}
        {iso.state === 'not-enforced' && (
          <div className="text-xs bg-amber-500/10 border border-amber-500/30 rounded p-2 text-amber-300">
            Not enforced{iso.reason ? ` (${sanitizeText(iso.reason)})` : ''}{iso.message ? `: ${sanitizeText(iso.message)}` : ''}
          </div>
        )}
        <CardRow label="RuntimeClass">
          {iso.runtimeClassName
            ? <Chip>{sanitizeText(iso.runtimeClassName)}</Chip>
            : <span className="text-xs text-gray-500">{iso.runtimeOptOut ? 'none (cluster default runtime)' : 'not reported'}</span>}
        </CardRow>
        {warning && (
          <p data-testid="hostname-warning" className="text-xs text-amber-300 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" aria-hidden />
            {warning}
          </p>
        )}
        {missingService && iso.egressRestricted?.message && (
          <p className="text-xs text-amber-300">{sanitizeText(iso.egressRestricted.message)}</p>
        )}
        {egress && (() => {
          const hostLabels = egressHostLabels(egress)
          return (
          <>
            <CardRow label="Allowed hosts">
              {hostLabels.length > 0
                ? <span className="flex flex-wrap justify-end gap-1">{hostLabels.map((h, i) => <Chip key={`${i}-${h}`}>{sanitizeText(h)}</Chip>)}</span>
                : <span className="text-xs text-gray-500">none (DNS, NATS and the baseline only)</span>}
            </CardRow>
            <CardRow label="Allowed ports">
              {egress.allowedPorts.length > 0
                ? <span className="flex flex-wrap justify-end gap-1">{egress.allowedPorts.map((p) => <Chip key={p}>{p}</Chip>)}</span>
                : <span className="text-xs text-gray-500">—</span>}
            </CardRow>
            <CardRow label="Allowed services">
              {egress.allowedServices.length > 0
                ? (
                  <span className="flex flex-wrap justify-end gap-1">
                    {egress.allowedServices.map((svc) => {
                      const label = `${svc.namespace ? `${svc.namespace}/` : ''}${svc.name}:${svc.ports.join(',')}`
                      return <Chip key={label}>{sanitizeText(label)}</Chip>
                    })}
                  </span>
                )
                : <span className="text-xs text-gray-500">none</span>}
            </CardRow>
            {egress.source === 'table' && <p className="text-[11px] text-gray-500">Allowlist inherited from the RoundTable default.</p>}
            {egress.source === 'default' && <p className="text-[11px] text-gray-500">No allowlist set: the operator default applies.</p>}
          </>
          )
        })()}
      </div>
    </div>
  )
}
