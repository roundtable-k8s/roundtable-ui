/**
 * The create/edit form for schedules (#302): form state, the Trigger spec it
 * makes, the request body for POST/PUT /api/schedules and the manifest the
 * YAML preview shows.
 *
 * The preview must equal what GET .../manifest returns after saving, so the
 * spec carries the defaults the API server fills in from the Trigger CRD
 * (concurrency.policy Allow, ttlSecondsAfterFinished 86400, a knight target's
 * timeoutSeconds 3600, a mission target's metaMission true). Editing starts
 * from the schedule's manifest and keeps every field the form does not show.
 */

import { toYaml, type JsonValue } from './yaml'

export type TargetKind = 'knight' | 'chain' | 'mission'
export type ConcurrencyPolicy = 'Allow' | 'Forbid' | 'Replace'

export interface ScheduleForm {
  name: string
  namespace: string
  /** spec.roundTableRef.name; empty for none. */
  table: string
  kind: TargetKind
  knight: string
  /** A knight target's task. */
  task: string
  chain: string
  /** A chain target's spec.input (a Go template); empty keeps the Chain's own. */
  input: string
  objective: string
  costBudgetUSD: string
  cron: string
  timeZone: string
  concurrency: ConcurrencyPolicy
  suspend: boolean
}

/** Field of the form a gateway error names. "" is the form as a whole. */
export type FormField = keyof ScheduleForm | ''

type Obj = { [key: string]: JsonValue | undefined }

/** A Trigger manifest, as GET .../manifest?format=json returns it. */
export interface TriggerManifest {
  apiVersion?: string
  kind?: string
  metadata: { name: string; namespace: string; labels?: Record<string, string>; annotations?: Record<string, string> } & Obj
  spec: Obj
}

export const TRIGGER_API_VERSION = 'ai.roundtable.io/v1alpha1'
export const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration'
export const GATEWAY_LABEL = 'app.kubernetes.io/managed-by'
export const GATEWAY_LABEL_VALUE = 'roundtable-gateway'
export const CALLER_ANNOTATION = 'ai.roundtable.io/caller'

// CRD defaults (roundtable api/v1alpha1/trigger_types.go).
export const DEFAULT_TTL_SECONDS = 86400
export const DEFAULT_KNIGHT_TIMEOUT_SECONDS = 3600

export function emptyForm(namespace: string): ScheduleForm {
  return {
    name: '', namespace, table: '', kind: 'knight', knight: '', task: '', chain: '', input: '',
    objective: '', costBudgetUSD: '1.00', cron: '0 7 * * 1-5', timeZone: 'UTC', concurrency: 'Forbid', suspend: false,
  }
}

function obj(v: JsonValue | undefined): Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {}
}

function str(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : ''
}

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v))
}

export function targetKind(spec: Obj): TargetKind {
  const t = obj(spec.target)
  if (t.knight) return 'knight'
  if (t.mission) return 'mission'
  return 'chain'
}

/** The form for an existing schedule's manifest. */
export function formFromManifest(m: TriggerManifest): ScheduleForm {
  const spec = m.spec
  const schedule = obj(obj(spec.source).schedule)
  const target = obj(spec.target)
  const knight = obj(target.knight)
  const mission = obj(target.mission)
  const policy = str(obj(spec.concurrency).policy)
  return {
    name: m.metadata.name,
    namespace: m.metadata.namespace,
    table: str(obj(spec.roundTableRef).name),
    kind: targetKind(spec),
    knight: str(knight.name),
    task: str(knight.task),
    chain: str(obj(target.chainRef).name),
    input: str(spec.input),
    objective: str(mission.objective),
    costBudgetUSD: str(mission.costBudgetUSD) || '1.00',
    cron: str(schedule.cron),
    timeZone: str(schedule.timeZone) || 'UTC',
    concurrency: policy === 'Forbid' || policy === 'Replace' ? policy : 'Allow',
    suspend: spec.suspend === true,
  }
}

/**
 * The Trigger spec for the form. base is the spec being edited: fields the
 * form does not show (startingDeadlineSeconds, dedupeKey, maxActive, a
 * knight's model, a mission's planner, ...) are kept, as long as the target
 * kind stays the same.
 */
export function buildSpec(f: ScheduleForm, base: Obj = {}): Obj {
  const spec: Obj = clone(base) ?? {}
  const baseTarget = obj(base.target)
  const sameKind = Object.keys(base).length > 0 && targetKind(base) === f.kind

  spec.source = { schedule: { ...obj(obj(base.source).schedule), cron: f.cron.trim(), timeZone: f.timeZone.trim() } }

  switch (f.kind) {
    case 'knight': {
      const k = sameKind ? obj(clone(baseTarget.knight)) : {}
      spec.target = { knight: { ...k, name: f.knight, task: f.task, timeoutSeconds: k.timeoutSeconds ?? DEFAULT_KNIGHT_TIMEOUT_SECONDS } }
      delete spec.input
      break
    }
    case 'chain':
      spec.target = { chainRef: { name: f.chain } }
      if (f.input) spec.input = f.input
      else delete spec.input
      break
    case 'mission': {
      const m = sameKind ? obj(clone(baseTarget.mission)) : {}
      spec.target = { mission: { ...m, objective: f.objective, costBudgetUSD: f.costBudgetUSD.trim(), metaMission: m.metaMission ?? true } }
      delete spec.input
      break
    }
  }

  spec.concurrency = { ...obj(base.concurrency), policy: f.concurrency }
  if (f.suspend) spec.suspend = true
  else delete spec.suspend
  if (f.table) spec.roundTableRef = { name: f.table }
  else delete spec.roundTableRef
  spec.ttlSecondsAfterFinished = base.ttlSecondsAfterFinished ?? DEFAULT_TTL_SECONDS
  return spec
}

/** The body of POST /api/schedules or PUT /api/schedules/{namespace}/{name}. */
export function buildRequest(f: ScheduleForm, base?: Obj): { name: string; namespace?: string; spec: Obj } {
  const req: { name: string; namespace?: string; spec: Obj } = { name: f.name.trim(), spec: buildSpec(f, base) }
  if (f.namespace.trim()) req.namespace = f.namespace.trim()
  return req
}

/**
 * The Trigger the manifest route would return for the form: metadata is the
 * edited schedule's (labels and annotations kept, like PUT keeps them), or
 * none for a new one. Pass the gateway's label and caller annotation as
 * extra metadata to get the manifest of a schedule created through the API.
 */
export function buildManifest(
  f: ScheduleForm,
  base?: TriggerManifest,
  extra?: { labels?: Record<string, string>; annotations?: Record<string, string> },
): Obj {
  const metadata: Obj = clone(base?.metadata) ?? {}
  metadata.name = f.name.trim()
  // An empty namespace is left to the gateway (its own namespace).
  metadata.namespace = f.namespace.trim() || undefined
  const labels = { ...(base?.metadata.labels ?? {}), ...(extra?.labels ?? {}) }
  const annotations: Record<string, string> = { ...(base?.metadata.annotations ?? {}), ...(extra?.annotations ?? {}) }
  delete annotations[LAST_APPLIED]
  metadata.labels = Object.keys(labels).length ? labels : undefined
  metadata.annotations = Object.keys(annotations).length ? annotations : undefined
  return { apiVersion: TRIGGER_API_VERSION, kind: 'Trigger', metadata, spec: buildSpec(f, base?.spec) }
}

/** The YAML preview: what GET .../manifest returns for the saved form. */
export function manifestYaml(
  f: ScheduleForm,
  base?: TriggerManifest,
  extra?: { labels?: Record<string, string>; annotations?: Record<string, string> },
): string {
  return toYaml(buildManifest(f, base, extra))
}

/** The form field a gateway 400's `field` is about. */
export function formFieldFor(field: string | undefined): FormField {
  if (!field) return ''
  const rules: [string, FormField][] = [
    ['name', 'name'],
    ['namespace', 'namespace'],
    ['spec.source.schedule.timeZone', 'timeZone'],
    ['spec.source', 'cron'],
    ['spec.target.knight.task', 'task'],
    ['spec.target.knight', 'knight'],
    ['spec.target.chainRef', 'chain'],
    ['spec.target.mission.costBudgetUSD', 'costBudgetUSD'],
    ['spec.target.mission', 'objective'],
    ['spec.target', 'kind'],
    ['spec.input', 'input'],
    ['spec.roundTableRef', 'table'],
    ['spec.concurrency', 'concurrency'],
    ['spec.suspend', 'suspend'],
  ]
  for (const [prefix, f] of rules) {
    if (field === prefix || field.startsWith(prefix + '.') || field.startsWith(prefix + '[')) return f
  }
  return ''
}

/** Strips the gateway's "invalid request: <field>: " prefix from a field error. */
export function fieldMessage(message: string, field?: string): string {
  let m = message.replace(/^invalid request:\s*/, '')
  if (field && m.startsWith(field + ': ')) m = m.slice(field.length + 2)
  return m
}
