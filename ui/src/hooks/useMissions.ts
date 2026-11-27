import { usePolledFetch } from './usePolledFetch'
import { useTableFilter } from './useTableFilter'
import { withTable } from '../lib/tables'
import type { TokenTotals } from '../lib/types'

export interface PlanningResult {
  completedAt: string
  chainsGenerated: number
  knightsGenerated: number
  skillsGenerated: number
  error?: string
  rawOutput?: string
  reasoning?: string
}

export interface KnightStatus {
  name: string
  ready: boolean
  tasksCompleted: number
  ephemeral: boolean
}

export interface ChainStatus {
  name: string
  chainCRName: string
  phase: string
  costUSD?: string
  tokens?: TokenTotals | null
  /** The part of costUSD spent by subscription-billed knights (notional). */
  notionalCostUSD?: string
}

export interface Mission {
  /** RoundTable the object belongs to; "none" when unset. List endpoints accept ?table=<name>. */
  table?: string
  name: string
  namespace: string
  phase: string
  objective: string
  startedAt: string | null
  expiresAt: string | null
  /** null until the planner/operator assigns knights (meta-missions start empty) */
  knights: string[] | null
  chains: string[] | null
  costBudgetUSD: string
  totalCost: string
  ttlSeconds: number
  timeoutSeconds: number
  roundTableRef: string
  metaMission?: boolean
  planningResult?: PlanningResult
  knightStatuses?: KnightStatus[]
  chainStatuses?: ChainStatus[]
  completedAt?: string
  /** status.traceID (32 hex characters). */
  traceId?: string
  successCriteria?: string
  briefing?: string
  /** Token use of the mission's chains. */
  tokens?: TokenTotals | null
  /** The part of totalCost spent by subscription-billed knights (notional). */
  notionalCostUSD?: string
  /** Detail endpoint only: metadata.creationTimestamp. */
  createdAt?: string
  /** Detail endpoint only: status.conditions. */
  conditions?: MissionCondition[]
  /** Detail endpoint only: per-knight cost, malformed entries dropped. */
  costBreakdown?: MissionKnightCost[]
  /** Detail endpoint only: status.result, capped at 4000 characters. */
  result?: string
}

export interface MissionCondition {
  type: string
  status: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export interface MissionKnightCost {
  name: string
  costUSD: string
  ephemeral: boolean
}

export function useMissions(refreshInterval = 10000) {
  const { table } = useTableFilter()
  const { data: missions, loading, error, refresh } = usePolledFetch<Mission[]>(withTable('/api/missions', table), refreshInterval, [])
  return { missions, loading, error, refresh }
}
