/**
 * Validation for the Create Mission wizard (#380). The rules mirror the API
 * (validK8sName, TTL 60-604800, timeout 60-86400) so a mistake shows next to
 * its field instead of as an API error on the last step.
 */

export interface MissionFormValues {
  name: string
  objective: string
  costBudgetUSD: string
  /** Number inputs stay strings while editing and are converted on submit. */
  ttl: string
  timeout: string
  knights: { name: string; role?: string }[]
  metaMission: boolean
  planner: { timeout: string; maxChains: string; maxKnights: string }
}

/** field key -> message. Keys: name, objective, costBudgetUSD, ttl, timeout,
 *  knights, knights.<index> (duplicate), planner.timeout, planner.maxChains, planner.maxKnights. */
export type MissionFormErrors = Record<string, string>

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const INT_RE = /^\d+$/
const BUDGET_RE = /^\d+(\.\d{1,2})?$/

function intInRange(v: string, min: number, max: number): boolean {
  const s = v.trim()
  if (!INT_RE.test(s)) return false
  const n = Number(s)
  return n >= min && n <= max
}

export function validateMissionForm(f: MissionFormValues): MissionFormErrors {
  const e: MissionFormErrors = {}
  if (!NAME_RE.test(f.name)) {
    e.name = 'Name must be lowercase letters, digits or "-", start and end with a letter or digit, and be at most 63 characters'
  }
  const objective = f.objective.trim()
  if (objective.length < 1 || objective.length > 1000) {
    e.objective = 'Objective must be 1 to 1000 characters'
  }
  if (!intInRange(f.ttl, 60, 604800)) e.ttl = 'TTL must be between 60 and 604800 seconds'
  if (!intInRange(f.timeout, 60, 86400)) e.timeout = 'Timeout must be between 60 and 86400 seconds'
  const budget = f.costBudgetUSD.trim()
  if (!BUDGET_RE.test(budget) || Number(budget) <= 0) {
    e.costBudgetUSD = 'Budget must be a positive number with at most two decimals'
  }
  if (f.metaMission) {
    if (!intInRange(f.planner.timeout, 1, 86400)) e['planner.timeout'] = 'Planner timeout must be between 1 and 86400 seconds'
    if (!intInRange(f.planner.maxChains, 1, 20)) e['planner.maxChains'] = 'Max chains must be between 1 and 20'
    if (!intInRange(f.planner.maxKnights, 1, 50)) e['planner.maxKnights'] = 'Max knights must be between 1 and 50'
  } else {
    const seen = new Set<string>()
    let any = false
    f.knights.forEach((k, i) => {
      const n = k.name.trim()
      if (!n) return
      any = true
      if (seen.has(n)) e[`knights.${i}`] = `Knight "${n}" is listed more than once`
      seen.add(n)
    })
    if (!any) e.knights = 'Add at least one knight'
  }
  return e
}

/** The wizard step (0 Basics, 1 Knights, 2 Advanced) a field's error belongs to. */
export function stepOfField(key: string): number {
  if (key.startsWith('knights')) return 1
  if (key.startsWith('planner.')) return 2
  return 0
}

/** The first step with an error, or -1 when the form is valid. */
export function firstInvalidStep(errors: MissionFormErrors): number {
  const steps = Object.keys(errors).map(stepOfField)
  return steps.length ? Math.min(...steps) : -1
}
