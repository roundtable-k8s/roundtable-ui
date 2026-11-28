import { usePolledFetch } from './usePolledFetch'
import { useTableFilter } from './useTableFilter'
import { withTable } from '../lib/tables'

/** status values the API produces */
export type KnightStatusValue = 'online' | 'offline' | 'starting' | 'scaled-to-zero'
/** KnightStatusValue plus 'busy', which the client derives from queue load */
export type DisplayStatus = KnightStatusValue | 'busy'

export interface KnightCondition {
  type: string
  status: string
  reason?: string
  message?: string
  lastTransitionTime?: string
}

export interface GeneratedSkill {
  name: string
  content: string
}

export interface KnightPod {
  name: string
  node?: string
  phase: string
  ready: boolean
  restarts: number
  lastTerminationReason?: string
  age: string
  createdAt?: string  // RFC 3339 pod creation time
  startedAt?: string
  image?: string
  draining: boolean
  // Kubernetes quantity strings ("150m", "256Mi"); usage absent without metrics-server
  cpu?: string
  memory?: string
  cpuRequest?: string
  cpuLimit?: string
  memoryRequest?: string
  memoryLimit?: string
}

export interface KnightScaling {
  autoscaled: boolean
  minReplicas: number
  maxReplicas: number
  desiredReplicas?: number
  currentReplicas: number
  readyReplicas: number
  lastScaleTime?: string
}

export type IsolationState = 'isolated' | 'opted-out' | 'not-enforced' | 'unknown'

export interface EgressService {
  name: string
  namespace?: string
  ports: number[]
}

export interface EgressHost {
  host: string
  /** set when the host is allowed only on these ports */
  ports?: number[]
}

export interface KnightEgress {
  allowedHosts: string[]
  /** same hosts with their per-host ports; absent on older APIs */
  allowedHostEntries?: EgressHost[]
  allowedPorts: number[]
  allowedServices: EgressService[]
  /** "knight" (spec.egress) or "table" (the RoundTable's default) */
  source: 'knight' | 'table' | 'default'
}

/** How isolated a knight is and what it may reach (#269). */
export interface KnightIsolation {
  state: IsolationState
  reason?: string             // Isolated condition reason
  message?: string            // Isolated condition message
  runtimeOptOut?: boolean     // spec.isolation.runtime: none
  egressOptOut?: boolean      // spec.isolation.egress: unrestricted
  optOutReason?: string       // spec.isolation.reason
  runtimeClassName?: string   // effective RuntimeClass
  hostnameRulesEnforced: boolean
  egress?: KnightEgress
  isolated?: KnightCondition
  egressRestricted?: KnightCondition
}

export interface WorkspaceSnapshot {
  name: string
  createdAt?: string
  readyToUse: boolean
}

export interface Knight {
  /** Kubernetes namespace of the Knight; the gateway invoke body takes it. */
  namespace?: string
  /** RoundTable the object belongs to; "none" when unset. List endpoints accept ?table=<name>. */
  table?: string
  name: string
  domain: string
  status: KnightStatusValue
  ready: boolean
  restarts: number
  age: string
  createdAt?: string  // RFC 3339; pod (or Knight CR when no pod) creation time
  startedAt?: string  // RFC 3339; container start time (uptime basis)
  image: string
  skillsList?: string[]    // actual skill names from CRD
  generatedSkills?: GeneratedSkill[]
  labels: Record<string, string>
  // fields from Knight CRD:
  phase?: string           // Pending | Provisioning | Ready | Degraded | Suspended
  model?: string           // e.g. claude-sonnet-4-20250514
  runtime?: string         // deployment | sandbox
  suspend?: boolean
  tasksCompleted?: number
  tasksFailed?: number
  totalCost?: string
  concurrency?: number
  taskTimeoutSeconds?: number
  natsPrefix?: string      // NATS prefix of the knight's RoundTable (#239)
  conditions?: KnightCondition[]
  pods?: KnightPod[]
  scaling?: KnightScaling
  isolation?: KnightIsolation
  workspaceSnapshots?: WorkspaceSnapshot[]
  workspaceSnapshotsCondition?: { status: string; reason?: string; message?: string }
}

export function useFleet(refreshInterval = 10000) {
  const { table } = useTableFilter()
  const { data: knights, loading, error, refresh } = usePolledFetch<Knight[]>(withTable('/api/fleet', table), refreshInterval, [])
  return { knights, loading, error, refresh }
}
