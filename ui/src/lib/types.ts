/**
 * Shared domain types matching the Go API's response DTOs
 * (api/main.go RoundTableSummary, ChainSummary, StepSummary).
 * Knight and Mission live with their data hooks (useFleet, useMissions).
 */

export interface RoundTable {
  name: string
  namespace: string
  phase: string
  knightsReady: number
  knightsTotal: number
  natsPrefix: string
  costBudgetUSD: string
  totalCost: string
  warmPool?: {
    available: number
    provisioning: number
    claimed: number
  }
  policies?: {
    maxConcurrentTasks: number
    costBudgetUSD: string
    maxKnights: number
    maxMissions: number
  }
  activeMissions?: number
  totalTasksCompleted?: number
  description?: string
  suspend?: boolean
  ephemeral?: boolean
}

export interface ChainStep {
  name: string
  knight: string
  domain: string
  phase: string
  startTime: string | null
  completionTime: string | null
  result: string | null
  dependsOn: string[] | null
  retryCount: number
  continueOnFailure?: boolean
  outputPath?: string
  maxRetries?: number
  /** forEach fan-out state; unset for ordinary steps. */
  fanOut?: ChainFanOut | null
  /** Bounded loop state; unset for ordinary steps. */
  loop?: ChainLoop | null
  /** Why the step is in its phase, e.g. WhenFalse / ChainFailed for Skipped. */
  skipReason?: string
  /** The step's `when` expression, shown with a WhenFalse skip. */
  when?: string
  /** Pre-formatted skip message from the API. */
  skipMessage?: string
  /** forEach concurrency cap (on the step, not inside fanOut). */
  maxParallel?: number
}

/** In-flight registry view of a running task (api ChainTaskInFlight). */
export interface ChainTaskInFlight {
  knight?: string
  pod?: string
  node?: string
  /** running | stale | lost */
  status?: string
  reason?: string
  startedAt?: string
  elapsedMs: number
  lastHeartbeat?: string
  heartbeatAgeMs?: number
  currentTool?: string
}

/** Fields shared by fan-out items and loop body steps. */
export interface ChainTaskLive {
  taskId?: string
  /** Set by the API only while the task is running and in the registry. */
  inFlight?: ChainTaskInFlight | null
  startTime?: string | null
  completionTime?: string | null
  error?: string
  outputBytes?: number
  retries?: number
}

/** One forEach item (operator status.stepStatuses[].fanOut.items[]). */
export interface ChainItem extends ChainTaskLive {
  index: number
  phase: string
  runId?: string
}

/**
 * forEach fan-out progress. Counters cover every item; `items` lists only
 * in-flight items plus a bounded set of finished ones — the rest are counted
 * in `omittedItems`.
 */
export interface ChainFanOut {
  total: number
  pending?: number
  running?: number
  succeeded?: number
  failed?: number
  skipped?: number
  omittedItems?: number
  items?: ChainItem[] | null
}

/** A loop body step in one round. */
export interface ChainLoopStep extends ChainTaskLive {
  name: string
  phase: string
  knight?: string
  iteration?: number
}

export interface ChainLoopRound {
  iteration: number
  steps: ChainLoopStep[]
}

/** Loop step state: round counter, outcome and body steps per round. */
export interface ChainLoop {
  iteration: number
  maxIterations: number
  /** spec.loop.onExhausted: fail | continue */
  onExhausted?: string
  /** Converged | Exhausted | Failed once the loop ends. */
  outcome?: string
  rounds?: ChainLoopRound[] | null
}

export interface Chain {
  name: string
  namespace: string
  phase: string
  currentStep: string
  startTime: string | null
  completionTime: string | null
  steps: ChainStep[] | null
  schedule?: string
  description?: string
  timeoutSeconds?: number
  outputKnightRef?: string
  roundTableRef?: string
  missionRef?: string
  suspend?: boolean
  runsCompleted?: number
  runsFailed?: number
}
