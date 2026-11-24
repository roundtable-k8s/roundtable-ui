import type { KnightPod } from '../hooks/useFleet'

const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1,
  k: 1e3, M: 1e6, G: 1e9, T: 1e12,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
}

/** Parse a Kubernetes quantity ("150m", "256Mi") to a plain number; null if absent/invalid. */
export function parseQuantity(q?: string): number | null {
  if (!q) return null
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(q.trim())
  if (!m || !(m[2] in SUFFIX)) return null
  const n = parseFloat(m[1]) * SUFFIX[m[2]]
  return Number.isFinite(n) ? n : null
}

/** Usage as a 0..1 fraction of the limit (falling back to the request); null when unknown. */
export function usageFraction(usage?: string, limit?: string, request?: string): number | null {
  const u = parseQuantity(usage)
  const cap = parseQuantity(limit) || parseQuantity(request)
  if (u === null || !cap) return null
  return u / cap
}

export type ReplicaState = 'ready' | 'draining' | 'starting'

/** Replica dot state for one pod: draining wins, then ready, else starting. */
export function podState(p: KnightPod): ReplicaState {
  if (p.draining) return 'draining'
  return p.ready ? 'ready' : 'starting'
}

export function formatCpu(q?: string): string {
  const n = parseQuantity(q)
  if (n === null) return '—'
  return n < 1 ? `${Math.round(n * 1000)}m` : `${+n.toFixed(2)}`
}

export function formatMemory(q?: string): string {
  const n = parseQuantity(q)
  if (n === null) return '—'
  if (n >= 1024 ** 3) return `${+(n / 1024 ** 3).toFixed(1)}Gi`
  return `${Math.round(n / 1024 ** 2)}Mi`
}
