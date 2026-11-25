export interface TriggerSource {
  type: 'schedule' | 'nats' | 'webhook' | 'github' | 'unknown'
  detail: string
  cron?: string
  timeZone?: string
  subject?: string
  eventType?: string
  auth?: string
}

export interface TriggerFiring {
  time: string
  key?: string
  run?: string
  skipReason?: string
}

export interface TriggerCondition {
  type: string
  status: string
  reason?: string
  message?: string
}

export interface Trigger {
  name: string
  namespace: string
  source: TriggerSource
  targetChain: string
  concurrencyPolicy: string
  maxActive?: number
  suspended: boolean
  roundTableRef?: string
  lastFiredAt?: string
  lastScheduledAt?: string
  nextScheduledAt?: string
  recentFirings: TriggerFiring[]
  activeRuns: string[]
  conditions: TriggerCondition[]
  ready: 'true' | 'false' | 'unknown'
}

export const TRIGGER_DOCS_URL = 'https://github.com/roundtable-k8s/roundtable/blob/main/docs/crd-design.md'

/** Deep link to the chain a trigger starts (and, via ?run=, one of its runs). */
export function chainLink(chain: string, run?: string): string {
  const q = new URLSearchParams({ chain })
  if (run) q.set('run', run)
  return `/chains?${q.toString()}`
}
