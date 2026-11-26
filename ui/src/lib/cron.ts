/**
 * Cron expressions as the trigger controller reads them (robfig/cron v3,
 * ParseStandard): five fields (minute hour day-of-month month day-of-week)
 * or a descriptor (@hourly, @daily, @every 1h30m, ...), evaluated in an IANA
 * time zone. Used for the "next runs" preview of the schedule form (#302).
 * The gateway checks the expression itself when the schedule is saved.
 */

export class CronError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronError'
  }
}

interface Field {
  min: number
  max: number
  names?: Record<string, number>
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

const FIELDS: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 6, names: DOW_NAMES },
]
const FIELD_NAMES = ['minute', 'hour', 'day of month', 'month', 'day of week']

const DESCRIPTORS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

interface FieldSet {
  values: number[]
  /** "*" or "?" (robfig's starBit): day-of-month and day-of-week then both have to match. */
  star: boolean
}

export interface CronSpec {
  kind: 'cron'
  minute: FieldSet
  hour: FieldSet
  dom: FieldSet
  month: FieldSet
  dow: FieldSet
}

export interface EverySpec {
  kind: 'every'
  /** Milliseconds, whole seconds, at least one. */
  intervalMs: number
}

export type Schedule = CronSpec | EverySpec

function parseNumber(s: string, f: Field, name: string): number {
  const named = f.names?.[s.toLowerCase()]
  if (named !== undefined) return named
  if (!/^[0-9]+$/.test(s)) throw new CronError(`${name}: "${s}" is not a number`)
  return Number(s)
}

/** robfig getRange for one comma-separated part of a field. */
function parseRange(expr: string, f: Field, name: string): { values: number[]; star: boolean } {
  const rangeAndStep = expr.split('/')
  const lowAndHigh = rangeAndStep[0].split('-')
  let start: number
  let end: number
  let star = false
  if (lowAndHigh[0] === '*' || lowAndHigh[0] === '?') {
    if (lowAndHigh.length > 1) throw new CronError(`${name}: "${expr}" is not a valid range`)
    start = f.min
    end = f.max
    star = true
  } else {
    start = parseNumber(lowAndHigh[0], f, name)
    if (lowAndHigh.length === 1) end = start
    else if (lowAndHigh.length === 2) end = parseNumber(lowAndHigh[1], f, name)
    else throw new CronError(`${name}: too many hyphens in "${expr}"`)
  }
  let step = 1
  if (rangeAndStep.length === 2) {
    if (!/^[0-9]+$/.test(rangeAndStep[1])) throw new CronError(`${name}: step "${rangeAndStep[1]}" is not a number`)
    step = Number(rangeAndStep[1])
    // "N/step" means "N-max/step".
    if (lowAndHigh.length === 1) end = f.max
    if (step > 1) star = false
  } else if (rangeAndStep.length > 2) {
    throw new CronError(`${name}: too many slashes in "${expr}"`)
  }
  if (start < f.min) throw new CronError(`${name}: ${start} is below the minimum ${f.min}`)
  if (end > f.max) throw new CronError(`${name}: ${end} is above the maximum ${f.max}`)
  if (start > end) throw new CronError(`${name}: ${start} is after ${end}`)
  if (step === 0) throw new CronError(`${name}: step must be at least 1`)
  const values: number[] = []
  for (let v = start; v <= end; v += step) values.push(v)
  return { values, star }
}

function parseField(expr: string, i: number): FieldSet {
  const set = new Set<number>()
  let star = false
  for (const part of expr.split(',')) {
    const r = parseRange(part, FIELDS[i], FIELD_NAMES[i])
    r.values.forEach((v) => set.add(v))
    star = star || r.star
  }
  return { values: [...set].sort((a, b) => a - b), star }
}

const DURATION_UNITS: Record<string, number> = { ns: 1e-6, us: 1e-3, 'µs': 1e-3, ms: 1, s: 1000, m: 60000, h: 3600000 }

/** A Go duration ("1h30m", "90s", "1.5h") in milliseconds. */
function parseDuration(s: string): number {
  const re = /([0-9]*\.?[0-9]+)(ns|us|µs|ms|s|m|h)/gy
  let total = 0
  let pos = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    total += Number(m[1]) * DURATION_UNITS[m[2]]
    pos = re.lastIndex
  }
  if (pos === 0 || pos !== s.length) throw new CronError(`"${s}" is not a duration such as 1h30m`)
  return total
}

export function parseCron(expr: string): Schedule {
  const e = expr.trim()
  if (!e) throw new CronError('the cron expression is empty')
  if (/^(CRON_)?TZ=/.test(e)) throw new CronError('set the time zone in its own field, not with a TZ= prefix')
  if (e.startsWith('@every ')) {
    // robfig rounds the delay to whole seconds, with one second at least.
    const ms = Math.max(1000, Math.round(parseDuration(e.slice(7).trim()) / 1000) * 1000)
    return { kind: 'every', intervalMs: ms }
  }
  const fields = (DESCRIPTORS[e] ?? (e.startsWith('@') ? undefined : e))?.split(/\s+/)
  if (!fields) throw new CronError(`unknown descriptor "${e}"`)
  if (fields.length !== 5) throw new CronError(`expected 5 fields (minute hour day-of-month month day-of-week), found ${fields.length}`)
  const [minute, hour, dom, month, dow] = fields.map(parseField)
  return { kind: 'cron', minute, hour, dom, month, dow }
}

// ---- time zones ----

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    formatters.set(tz, f)
  }
  return f
}

/** Whether tz is an IANA zone this browser knows (the gateway refuses "Local"). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz === 'Local') return false
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}

interface Wall {
  y: number
  m: number
  d: number
  h: number
  mi: number
}

/** The wall-clock time of instant t (ms) in tz, to the minute. */
function wallTime(t: number, tz: string): Wall {
  const parts: Record<string, number> = {}
  for (const p of formatter(tz).formatToParts(new Date(t))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24, mi: parts.minute }
}

function wallMs(w: Wall): number {
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi)
}

/** The instants whose wall time in tz is w: none in a DST gap, two in a
 *  repeated hour, else one. Sorted. */
function instantsAt(w: Wall, tz: string): number[] {
  const guess = wallMs(w)
  const out = new Set<number>()
  for (const probe of [guess - 86400000, guess, guess + 86400000]) {
    const offset = wallMs(wallTime(probe, tz)) - Math.floor(probe / 60000) * 60000
    const t = guess - offset
    if (wallMs(wallTime(t, tz)) === guess) out.add(t)
  }
  return [...out].sort((a, b) => a - b)
}

const MAX_DAYS = 366 * 5

/**
 * The next `count` times the schedule fires after `from`, in time zone tz
 * (default UTC). Throws CronError for an invalid expression or time zone. A
 * wall time that a DST change skips does not fire; one it repeats fires at
 * both instants, as the controller's cron library does.
 */
export function nextRuns(expr: string, tz: string, from: Date, count = 3): Date[] {
  const zone = tz || 'UTC'
  if (!isValidTimeZone(zone)) throw new CronError(`"${tz}" is not an IANA time zone name such as "America/New_York"`)
  const s = parseCron(expr)
  const fromMs = from.getTime()
  if (s.kind === 'every') {
    // robfig's ConstantDelaySchedule: from + interval, at a whole second.
    const base = Math.floor(fromMs / 1000) * 1000
    return Array.from({ length: count }, (_, i) => new Date(base + (i + 1) * s.intervalMs))
  }
  const out: number[] = []
  const start = wallTime(fromMs, zone)
  const startDay = Date.UTC(start.y, start.m - 1, start.d)
  const months = new Set(s.month.values)
  const doms = new Set(s.dom.values)
  const dows = new Set(s.dow.values)
  for (let i = 0; i < MAX_DAYS && out.length < count; i++) {
    const day = new Date(startDay + i * 86400000)
    const y = day.getUTCFullYear()
    const m = day.getUTCMonth() + 1
    const d = day.getUTCDate()
    if (!months.has(m)) continue
    const domMatch = doms.has(d)
    const dowMatch = dows.has(day.getUTCDay())
    if (s.dom.star || s.dow.star ? !(domMatch && dowMatch) : !(domMatch || dowMatch)) continue
    for (const h of s.hour.values) {
      // Hours well before the start cannot fire after it, even across a DST shift.
      if (i === 0 && h < start.h - 2) continue
      for (const mi of s.minute.values) {
        for (const t of instantsAt({ y, m, d, h, mi }, zone)) {
          if (t > fromMs && !out.includes(t)) out.push(t)
        }
        if (out.length >= count) break
      }
      if (out.length >= count) break
    }
  }
  return out.sort((a, b) => a - b).slice(0, count).map((t) => new Date(t))
}

/** A few common cadences for the form. */
export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every day at 07:00', cron: '0 7 * * *' },
  { label: 'Weekdays at 07:00', cron: '0 7 * * 1-5' },
  { label: 'Mondays at 09:00', cron: '0 9 * * 1' },
  { label: 'First of the month at 08:00', cron: '0 8 1 * *' },
]

/** A time in tz for the preview, e.g. "Mon, 30 Nov 2026, 07:00". */
export function formatInZone(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d)
}
