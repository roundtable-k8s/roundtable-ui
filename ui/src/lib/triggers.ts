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
  /** RoundTable the object belongs to; "none" when unset. List endpoints accept ?table=<name>. */
  table?: string
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

export const TRIGGER_DOCS_URL = 'https://github.com/roundtable-k8s/roundtable/blob/main/docs/triggers.md'

/** Deep link to a chain (a trigger target, or a run, which is its own Chain object). */
export function chainLink(chain: string): string {
  const q = new URLSearchParams({ chain })
  return `/chains?${q.toString()}`
}
