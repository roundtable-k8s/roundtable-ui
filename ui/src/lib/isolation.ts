import type { Knight, IsolationState, KnightIsolation, KnightEgress } from '../hooks/useFleet'
import { sanitizeText } from './untrusted'

export const ISOLATION_LABEL: Record<IsolationState, string> = {
  isolated: 'isolated',
  'opted-out': 'opted out',
  'not-enforced': 'not enforced',
  unknown: 'isolation unknown',
}

export const ISOLATION_CLASS: Record<IsolationState, string> = {
  isolated: 'bg-green-500/10 text-green-400 border-green-500/20',
  'opted-out': 'bg-red-500/15 text-red-300 border-red-500/40',
  'not-enforced': 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  unknown: 'bg-gray-500/10 text-gray-400 border-gray-500/20',
}

/** True when the knight opts out of isolation or isolation is not enforced. */
export function isNotIsolated(knight: Pick<Knight, 'isolation'>): boolean {
  const state = knight.isolation?.state
  return state === 'opted-out' || state === 'not-enforced'
}

/** "runtime: none, egress: unrestricted" — what the knight opts out of. */
export function optOutSummary(iso: KnightIsolation): string {
  return [iso.runtimeOptOut && 'runtime: none', iso.egressOptOut && 'egress: unrestricted'].filter(Boolean).join(', ')
}

/** Hover text for the isolation badge: why the knight is (not) isolated. */
export function isolationTooltip(iso: KnightIsolation): string {
  if (iso.state === 'opted-out') {
    const what = optOutSummary(iso)
    const reason = sanitizeText(iso.optOutReason || iso.message || 'no reason given')
    return what ? `Opted out (${what}): ${reason}` : `Opted out: ${reason}`
  }
  if (iso.state === 'unknown') return 'The operator has not reported an Isolated condition for this knight'
  const msg = sanitizeText(iso.message)
  return iso.reason ? `${iso.reason}${msg ? `: ${msg}` : ''}` : msg
}

/** "host:5000,5001" for hosts with their own ports, the plain host otherwise. */
export function egressHostLabels(egress: KnightEgress): string[] {
  const entries = egress.allowedHostEntries
  if (!entries) return egress.allowedHosts
  return entries.map((e) => (e.ports && e.ports.length > 0 ? `${e.host}:${e.ports.join(',')}` : e.host))
}
