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
    costBudgetUSD: string
    maxConcurrentPlanTasks: number
    maxMissions: number
  }
  activeMissions?: number
  totalTasksCompleted?: number
  description?: string
  suspend?: boolean
  ephemeral?: boolean
  /** Knight that plans this table's missions; empty when unknown. */
  plannerKnight?: string
  /** False when the planner is disabled or the table is ephemeral. */
  plannerEnabled?: boolean
  knightsScaledToZero?: number
  knightsSuspended?: number
  knightsNotReady?: number
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
  /** USD cost, summed over retries, fan-out items and loop rounds; unset without cost data. */
  costUSD?: string
  tokens?: TokenTotals | null
  /** The knight is subscription-billed: costUSD is an API-equivalent estimate, not spend. */
  costNotional?: boolean
}

/** Input and output token totals (api TokenTotals). */
export interface TokenTotals {
  input: number
  output: number
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
  /** Truncated (1 KiB) output of a finished earlier-round run (status.loop.history). */
  outputSummary?: string
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
  /** RoundTable the object belongs to; "none" when unset. List endpoints accept ?table=<name>. */
  table?: string
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
  timeZone?: string
  nextScheduledAt?: string
  lastScheduledAt?: string
  runsCompleted?: number
  runsFailed?: number
  /** status.traceID of the current run (32 hex characters). */
  traceId?: string
  /** Carries ai.roundtable.io/invokable=true: the gateway can run it. */
  invokable?: boolean
  /** Cost of the current (or most recent) run: the sum of its steps'. */
  costUSD?: string
  tokens?: TokenTotals | null
  /** The part of costUSD spent by subscription-billed knights (notional). */
  notionalCostUSD?: string
  /** Template Chain this one is a run copy of (ai.roundtable.io/run-template). */
  runTemplate?: string
  /**
   * Set on GET /api/chains list items: steps carry only name and phase.
   * The full chain comes from GET /api/chains/{name} or a WS push.
   */
  slim?: boolean
}

/** GET /api/chain-groups: the run copies of one template. */
export interface ChainRunGroup {
  template: string
  runs: number
  /** Copies per phase. */
  phases: Record<string, number>
  /** Start of the newest copy. */
  lastStartTime?: string | null
  /** False when the template Chain itself no longer exists. */
  templateExists: boolean
}
