import { usePolledFetch } from './usePolledFetch'

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

export interface Knight {
  name: string
  domain: string
  status: 'online' | 'offline' | 'starting' | 'busy' | 'scaled-to-zero'
  ready: boolean
  restarts: number
  age: string
  image: string
  skills: number           // keep for backward compat
  skillsList?: string[]    // actual skill names from CRD
  nixTools: number         // keep for backward compat
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
  conditions?: KnightCondition[]
  pods?: KnightPod[]
  scaling?: KnightScaling
}

export function useFleet(refreshInterval = 10000) {
  const { data: knights, loading, error, refresh } = usePolledFetch<Knight[]>('/api/fleet', refreshInterval, [])
  return { knights, loading, error, refresh }
}
