// Knight agent cards (#243): types, parsing and helpers for GET /api/cards
// and the `cards` WebSocket topic. Card schema: roundtable docs/agent-cards.md.
// Everything here is lenient: unknown or malformed input yields "no card",
// so the fleet views fall back to what they showed before cards existed.

export interface CardSkill {
  id?: string
  name: string
  description?: string
  tags?: string[]
}

export interface CardRoundtable {
  table?: string
  knight?: string
  domain?: string
  model?: string
  tools?: string[]
  tags?: string[]
  taskSubject?: string
  runtime?: string
  phase?: string
  readyReplicas?: number
  suspended?: boolean
  updatedAt?: string
}

export interface AgentCard {
  name?: string
  description?: string
  version?: string
  skills: CardSkill[]
  roundtable: CardRoundtable
}

export interface CardEntry {
  table: string
  knight: string
  card: AgentCard
  live: boolean
  stats: unknown
}

/** Map key for a card: `<table>.<knight>`, the same as the KV key. */
export function cardKey(table: string, knight: string): string {
  return `${table}.${knight}`
}

export type CardMap = Map<string, CardEntry>

export type CardPush =
  | { op: 'upsert'; entry: CardEntry }
  | { op: 'delete'; table: string; knight: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : undefined

function parseSkill(v: unknown): CardSkill | null {
  if (!isObj(v)) return null
  const name = str(v.name) ?? str(v.id)
  if (!name) return null
  return { id: str(v.id), name, description: str(v.description), tags: strList(v.tags) }
}

/** Parses a raw card document (or a JSON string of one); null if unusable. */
export function parseCard(raw: unknown): AgentCard | null {
  let v = raw
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return null }
  }
  if (!isObj(v)) return null
  const rt = isObj(v.roundtable) ? v.roundtable : {}
  const skills = Array.isArray(v.skills) ? v.skills.map(parseSkill).filter((s): s is CardSkill => s !== null) : []
  return {
    name: str(v.name),
    description: str(v.description),
    version: str(v.version) ?? (num(v.version) !== undefined ? String(v.version) : undefined),
    skills,
    roundtable: {
      table: str(rt.table),
      knight: str(rt.knight),
      domain: str(rt.domain),
      model: str(rt.model),
      tools: strList(rt.tools),
      tags: strList(rt.tags),
      taskSubject: str(rt.taskSubject),
      runtime: str(rt.runtime),
      phase: str(rt.phase),
      readyReplicas: num(rt.readyReplicas),
      suspended: rt.suspended === true,
      updatedAt: str(rt.updatedAt),
    },
  }
}

/** Parses one `{table, knight, card, live, stats}` entry; null if unusable. */
export function parseCardEntry(raw: unknown): CardEntry | null {
  if (!isObj(raw)) return null
  const card = parseCard(raw.card)
  if (!card) return null
  const table = str(raw.table) ?? card.roundtable.table ?? ''
  const knight = str(raw.knight) ?? card.roundtable.knight ?? card.name
  if (!knight) return null
  return { table, knight, card, live: raw.live === true, stats: raw.stats ?? null }
}

/** Parses a GET /api/cards body into a map keyed by cardKey. */
export function parseCardsResponse(body: unknown): CardMap {
  const out: CardMap = new Map()
  const list = isObj(body) && Array.isArray(body.cards) ? body.cards : []
  for (const raw of list) {
    const e = parseCardEntry(raw)
    if (e) out.set(cardKey(e.table, e.knight), e)
  }
  return out
}

/** Parses the `data` of a `cards` WS push; null if unusable. */
export function parseCardPush(data: unknown): CardPush | null {
  if (!isObj(data)) return null
  if (data.deleted === true) {
    const table = typeof data.table === 'string' ? data.table : ''
    const knight = str(data.knight)
    return knight ? { op: 'delete', table, knight } : null
  }
  const entry = parseCardEntry(data)
  return entry ? { op: 'upsert', entry } : null
}

/** Returns a new map with the push applied. */
export function applyCardPush(prev: CardMap, push: CardPush): CardMap {
  const next = new Map(prev)
  if (push.op === 'upsert') next.set(cardKey(push.entry.table, push.entry.knight), push.entry)
  else next.delete(cardKey(push.table, push.knight))
  return next
}

/**
 * The card for a fleet knight, matched on name (case-insensitive). When the
 * knight sits in several tables, `table` picks one; else the first match wins.
 */
export function cardForKnight(cards: CardMap, name: string, table?: string): CardEntry | undefined {
  const lower = name.toLowerCase()
  let first: CardEntry | undefined
  for (const e of cards.values()) {
    if (e.knight.toLowerCase() !== lower) continue
    if (!table || e.table === table) return e
    first ??= e
  }
  return first
}

export interface CardLoad {
  active: number
  max?: number
}

/** Objects that may carry the knight's stats counters, in priority order. */
function statsObjects(stats: unknown): Record<string, unknown>[] {
  if (!isObj(stats)) return []
  const out: Record<string, unknown>[] = [stats]
  if (isObj(stats.data)) out.push(stats.data)
  if (Array.isArray(stats.endpoints)) {
    for (const ep of stats.endpoints) if (isObj(ep) && isObj(ep.data)) out.push(ep.data)
  }
  return out
}

function loadOf(stats: unknown): CardLoad | null {
  for (const o of statsObjects(stats)) {
    const active = num(o.activeTasks)
    if (active !== undefined) return { active, max: num(o.maxConcurrentTasks) }
  }
  return null
}

/**
 * Load (active tasks / max) from the knight's latest STATS. Accepts the flat
 * stats object, a NATS micro STATS response (counters in endpoint `data`),
 * or an array of per-pod responses (summed). `max` falls back to the card,
 * then to `fallbackMax` (the Knight's concurrency).
 */
export function cardLoad(entry: CardEntry | undefined, fallbackMax?: number): CardLoad | null {
  if (!entry) return null
  let load: CardLoad | null = null
  if (Array.isArray(entry.stats)) {
    for (const s of entry.stats) {
      const l = loadOf(s)
      if (!l) continue
      load = load
        ? { active: load.active + l.active, max: load.max !== undefined && l.max !== undefined ? load.max + l.max : load.max ?? l.max }
        : l
    }
  } else {
    load = loadOf(entry.stats)
  }
  if (!load) return null
  return { active: load.active, max: load.max ?? fallbackMax }
}

/** All skill tags across cards, sorted and de-duplicated. */
export function cardSkillTags(cards: Iterable<CardEntry>): string[] {
  const tags = new Set<string>()
  for (const e of cards) for (const s of e.card.skills) for (const t of s.tags ?? []) tags.add(t)
  return [...tags].sort((a, b) => a.localeCompare(b))
}

export interface SkillFilter {
  /** Exact skill tag (case-insensitive); empty = any. */
  tag?: string
  /** Free text matched against skill names, descriptions and tags. */
  text?: string
}

export function isSkillFilterActive(f: SkillFilter): boolean {
  return Boolean(f.tag?.trim() || f.text?.trim())
}

/**
 * Whether a knight's card has a skill matching the filter. With no active
 * filter every knight matches; with one, a knight without a card never does.
 */
export function matchesSkillFilter(entry: CardEntry | undefined, f: SkillFilter): boolean {
  if (!isSkillFilterActive(f)) return true
  if (!entry) return false
  const tag = f.tag?.trim().toLowerCase()
  const text = f.text?.trim().toLowerCase()
  return entry.card.skills.some((s) => {
    const tags = (s.tags ?? []).map((t) => t.toLowerCase())
    if (tag && !tags.includes(tag)) return false
    if (!text) return true
    return [s.name, s.id ?? '', s.description ?? '', ...tags].some((v) => v.toLowerCase().includes(text))
  })
}
