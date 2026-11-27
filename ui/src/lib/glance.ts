/** Pure model of the Command Center "at a glance" strip (#480). */
import type { Health } from '../hooks/useHealth'
import type { Schedule } from './schedules'
import { queueWarnings, type KnightQueue } from './queues'

export type GlanceTone = 'ok' | 'warn' | 'bad' | 'unknown'

export interface GlanceItem {
  id: 'api' | 'knights' | 'failed' | 'schedules' | 'queues' | 'all-clear'
  label: string
  tone: GlanceTone
  to: string
}

/**
 * Each source is null when it has not loaded or failed to load: the item is then "unknown", never "ok".
 * Health and dead letters also carry flags (`error`, `loading`) for a failed or unanswered poll.
 */
export interface GlanceInput {
  health: Health | null
  knights: { status: string }[] | null
  deadLetters: { count: number; capped?: boolean; loading?: boolean; error?: boolean } | null
  schedules: Pick<Schedule, 'lastResult'>[] | null
  queues: KnightQueue[] | null
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function apiItem(health: Health | null): GlanceItem {
  const to = '/'
  if (!health || health.error) return { id: 'api', label: 'API status unknown', tone: 'unknown', to }
  const parts = [{ name: 'Kubernetes', v: health.kubernetes }, { name: 'NATS', v: health.nats }]
  const tone = (v?: string): GlanceTone => {
    if (!v) return 'unknown'
    if (v === 'reconnecting') return 'warn'
    if (v === 'unavailable' || v === 'disconnected') return 'bad'
    return 'ok'
  }
  const rank: Record<GlanceTone, number> = { bad: 3, warn: 2, unknown: 1, ok: 0 }
  let worst: GlanceTone = 'ok'
  const bad: string[] = []
  for (const p of parts) {
    const t = tone(p.v)
    if (t !== 'ok') bad.push(`${p.name} ${p.v ?? 'unknown'}`)
    if (rank[t] > rank[worst]) worst = t
  }
  return { id: 'api', label: worst === 'ok' ? 'API ok' : bad.join(', '), tone: worst, to }
}

/** Ordered items: problems and unknowns first-class, healthy ones collapsed into one "All clear" chip. */
export function glanceItems(input: GlanceInput): GlanceItem[] {
  const items: GlanceItem[] = [apiItem(input.health)]

  const { knights, deadLetters, schedules, queues } = input
  if (!knights) items.push({ id: 'knights', label: 'Knights unknown', tone: 'unknown', to: '/fleet' })
  else {
    const n = knights.filter((k) => k.status === 'offline').length
    items.push({ id: 'knights', label: plural(n, 'knight not ready', 'knights not ready'), tone: n > 0 ? 'bad' : 'ok', to: '/fleet?status=offline' })
  }
  if (!deadLetters || deadLetters.loading || deadLetters.error) items.push({ id: 'failed', label: 'Failed tasks unknown', tone: 'unknown', to: '/failed' })
  else {
    const n = deadLetters.count
    items.push({ id: 'failed', label: `${n}${deadLetters.capped ? '+' : ''} open failed ${n === 1 && !deadLetters.capped ? 'task' : 'tasks'}`, tone: n > 0 ? 'bad' : 'ok', to: '/failed' })
  }
  if (!schedules) items.push({ id: 'schedules', label: 'Schedules unknown', tone: 'unknown', to: '/schedules' })
  else {
    const n = schedules.filter((s) => s.lastResult?.outcome === 'failed' || s.lastResult?.outcome === 'lost').length
    items.push({ id: 'schedules', label: `${n} ${n === 1 ? 'schedule' : 'schedules'} failing`, tone: n > 0 ? 'bad' : 'ok', to: '/schedules' })
  }
  if (!queues) items.push({ id: 'queues', label: 'Queues unknown', tone: 'unknown', to: '/queues' })
  else {
    const n = queues.filter((q) => queueWarnings(q, undefined).length > 0).length
    items.push({ id: 'queues', label: `${n} ${n === 1 ? 'queue' : 'queues'} backed up`, tone: n > 0 ? 'warn' : 'ok', to: '/queues' })
  }

  const notOk = items.filter((i) => i.tone !== 'ok')
  return notOk.length === 0 ? [{ id: 'all-clear', label: 'All clear', tone: 'ok', to: '/' }] : notOk
}
