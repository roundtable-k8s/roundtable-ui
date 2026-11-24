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
}

/**
 * Live-task join from the in-flight registry (/api/running) for a running
 * item: which pod it runs on, how long it has run, and heartbeat age.
 */
export interface ChainTaskLive {
  taskId?: string
  pod?: string
  elapsedSeconds?: number
  heartbeatAgeSeconds?: number
  startTime?: string | null
  completionTime?: string | null
  error?: string
}

/** One forEach item (operator status.stepStatuses[].fanOut.items[]). */
export interface ChainItem extends ChainTaskLive {
  index: number
  phase: string
  runId?: string
  retries?: number
  /** Output length in bytes. */
  outputSize?: number
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
  maxParallel?: number
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
