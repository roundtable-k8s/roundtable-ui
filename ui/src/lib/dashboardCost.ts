import type { NatsEvent } from '../hooks/useWebSocket'
import { parseEvent } from './events'
import { formatDay } from './format'

export interface CostEntry {
  knight: string
  cost: number
  timestamp: string
  taskId: string
  success: boolean
}

export interface CostPanelData {
  totalCost: number
  costByKnight: { knight: string; cost: number; tasks: number; failures: number }[]
  dailyCosts: { day: string; date: string; cost: number }[]
  topTasks: CostEntry[]
}

/** The reader's local calendar day as YYYY-MM-DD: sortable and locale-independent. */
export function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function sumCosts(entries: CostEntry[]): number {
  return entries.reduce((sum, e) => sum + e.cost, 0)
}

/** One entry per result event that carries a positive cost. */
export function buildCostEntries(events: NatsEvent[]): CostEntry[] {
  const entries: CostEntry[] = []
  for (const event of events) {
    if (event.type !== 'result') continue
    const { knight, taskId, data } = parseEvent(event)
    const cost = typeof data.cost === 'number' ? data.cost : 0
    if (cost <= 0) continue
    entries.push({
      knight: knight || 'unknown',
      cost,
      timestamp: event.timestamp,
      taskId,
      success: data.success !== false,
    })
  }
  return entries
}

/** Per-knight totals, the last seven days of cost and the ten most expensive tasks. */
export function buildCostPanelData(entries: CostEntry[]): CostPanelData {
  const totalCost = sumCosts(entries)
  const byKnight: Record<string, { cost: number; tasks: number; failures: number }> = {}
  for (const entry of entries) {
    if (!byKnight[entry.knight]) byKnight[entry.knight] = { cost: 0, tasks: 0, failures: 0 }
    byKnight[entry.knight].cost += entry.cost
    byKnight[entry.knight].tasks++
    if (!entry.success) byKnight[entry.knight].failures++
  }
  const costByKnight = Object.entries(byKnight)
    .map(([knight, s]) => ({ knight, ...s }))
    .sort((a, b) => b.cost - a.cost)

  const days: Record<string, number> = {}
  for (const entry of entries) {
    const day = localDayKey(new Date(entry.timestamp))
    days[day] = (days[day] || 0) + entry.cost
  }
  const dailyCosts = Object.entries(days)
    .map(([day, cost]) => ({ day, date: formatDay(day), cost }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
    .slice(-7)

  const topTasks = [...entries].sort((a, b) => b.cost - a.cost).slice(0, 10)
  return { totalCost, costByKnight, dailyCosts, topTasks }
}
