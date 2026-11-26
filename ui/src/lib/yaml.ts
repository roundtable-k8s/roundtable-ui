/**
 * A YAML emitter that writes what the gateway's manifest route writes
 * (#302): sigs.k8s.io/yaml, i.e. the value as JSON, re-encoded by go-yaml v2
 * with its defaults. Same key order (yaml.v2's natural sort), the same scalar
 * styles (plain, single-quoted, double-quoted, literal block) and the same
 * folding of long scalars at 80 columns, so a schedule's YAML preview matches
 * byte for byte what GET .../manifest returns after saving it.
 *
 * Only JSON values are supported: objects, arrays, strings, finite numbers,
 * booleans and null. Undefined object members are left out, as JSON does.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined }

const BEST_INDENT = 2
const BEST_WIDTH = 80

// ---- character classes (yaml.v2 yamlprivateh.go, on code points) ----

function isBreak(c: number): boolean {
  return c === 0x0d || c === 0x0a || c === 0x85 || c === 0x2028 || c === 0x2029
}

function isSpace(c: number | undefined): boolean {
  return c === 0x20
}

function isBlank(c: number | undefined): boolean {
  return c === 0x20 || c === 0x09
}

/** is_blankz: blank, break or the end of the value. */
function isBlankz(c: number | undefined): boolean {
  return c === undefined || isBlank(c) || isBreak(c)
}

/** yaml.v2's is_printable: no C0 controls but \n, no DEL..U+009F, no
 *  surrogates, BOM or U+FFFE/F, and nothing beyond the BMP. */
function isPrintable(c: number): boolean {
  return c === 0x0a ||
    (c >= 0x20 && c <= 0x7e) ||
    (c >= 0xa0 && c <= 0xd7ff) ||
    (c >= 0xe000 && c <= 0xfffd && c !== 0xfeff)
}

// ---- tag resolution (yaml.v2 resolve.go): a plain scalar that would read
// back as anything but a string must be quoted ----

const NON_STRING_PLAIN = new Set([
  '', '~', 'null', 'Null', 'NULL',
  'y', 'Y', 'yes', 'Yes', 'YES', 'n', 'N', 'no', 'No', 'NO',
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'on', 'On', 'ON', 'off', 'Off', 'OFF',
  '.nan', '.NaN', '.NAN',
  '.inf', '.Inf', '.INF', '+.inf', '+.Inf', '+.INF', '-.inf', '-.Inf', '-.INF',
])

const YAML_FLOAT = /^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/
// strconv.ParseInt / ParseUint with base 0 (after "_" are removed), and the
// YAML 1.1 binary form.
const GO_INT = /^[-+]?(0[xX][0-9a-fA-F]+|0[oO]?[0-7]+|0[bB][01]+|0|[1-9][0-9]*)$/
const BASE60_FLOAT = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?$/
// parseTimestamp's layouts: 2006-1-2T15:4:5.999999999Z07:00 (T or t),
// 2006-1-2 15:4:5.999999999 and 2006-1-2.
const TIMESTAMP = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:([Tt])([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})(?:\.[0-9]+)?(?:Z|[-+][0-9]{2}:[0-9]{2})| ([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})(?:\.[0-9]+)?)?$/

function isTimestamp(s: string): boolean {
  const m = TIMESTAMP.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false
  const [h, mi, se] = (m[4] ? [m[5], m[6], m[7]] : [m[8], m[9], m[10]]).map((x) => Number(x ?? 0))
  return h < 24 && mi < 60 && se < 60
}

/** Whether yaml.v2 would resolve s, written plain, to a non-string. */
function resolvesToNonString(s: string): boolean {
  if (NON_STRING_PLAIN.has(s)) return true
  const hint = s.charAt(0)
  if (hint === '' || !'+-.0123456789'.includes(hint)) return false
  const plain = s.replace(/_/g, '')
  if (GO_INT.test(plain) || YAML_FLOAT.test(plain)) return true
  if (isTimestamp(s)) return true
  return false
}

// ---- scalar analysis (yaml_emitter_analyze_scalar) ----

interface Analysis {
  multiline: boolean
  blockPlainAllowed: boolean
  singleQuotedAllowed: boolean
  blockAllowed: boolean
}

function analyze(cps: number[]): Analysis {
  if (cps.length === 0) {
    return { multiline: false, blockPlainAllowed: true, singleQuotedAllowed: true, blockAllowed: false }
  }
  let blockIndicators = false
  let lineBreaks = false
  let special = false
  let leadingSpace = false
  let leadingBreak = false
  let trailingSpace = false
  let trailingBreak = false
  let breakSpace = false
  let spaceBreak = false
  let previousSpace = false
  let previousBreak = false
  let precededByWhitespace = true

  const head = String.fromCodePoint(...cps.slice(0, 3))
  if (head === '---' || head === '...') blockIndicators = true

  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]
    const followedByWhitespace = isBlankz(cps[i + 1])
    const ch = String.fromCodePoint(c)
    if (i === 0) {
      if ('#,[]{}&*!|>\'"%@`'.includes(ch)) blockIndicators = true
      else if ((ch === '?' || ch === ':' || ch === '-') && followedByWhitespace) blockIndicators = true
    } else if (ch === ':' && followedByWhitespace) {
      blockIndicators = true
    } else if (ch === '#' && precededByWhitespace) {
      blockIndicators = true
    }
    if (!isPrintable(c)) special = true
    if (isSpace(c)) {
      if (i === 0) leadingSpace = true
      if (i === cps.length - 1) trailingSpace = true
      if (previousBreak) breakSpace = true
      previousSpace = true
      previousBreak = false
    } else if (isBreak(c)) {
      lineBreaks = true
      if (i === 0) leadingBreak = true
      if (i === cps.length - 1) trailingBreak = true
      if (previousSpace) spaceBreak = true
      previousSpace = false
      previousBreak = true
    } else {
      previousSpace = false
      previousBreak = false
    }
    precededByWhitespace = isBlankz(c)
  }

  const a: Analysis = { multiline: lineBreaks, blockPlainAllowed: true, singleQuotedAllowed: true, blockAllowed: true }
  if (leadingSpace || leadingBreak || trailingSpace || trailingBreak) a.blockPlainAllowed = false
  if (trailingSpace) a.blockAllowed = false
  if (breakSpace) {
    a.blockPlainAllowed = false
    a.singleQuotedAllowed = false
  }
  if (spaceBreak || special) {
    a.blockPlainAllowed = false
    a.singleQuotedAllowed = false
    a.blockAllowed = false
  }
  if (lineBreaks) a.blockPlainAllowed = false
  if (blockIndicators) a.blockPlainAllowed = false
  return a
}

// ---- the writer: tracks the column like yaml_emitter_t ----

class Writer {
  out = ''
  column = 0
  whitespace = true
  indention = true

  put(s: string) {
    this.out += s
    this.column += [...s].length
  }

  breakLine() {
    this.out += '\n'
    this.column = 0
  }

  /** yaml_emitter_write_indent */
  writeIndent(indent: number) {
    if (!this.indention || this.column > indent || (this.column === indent && !this.whitespace)) this.breakLine()
    while (this.column < indent) this.put(' ')
    this.whitespace = true
    this.indention = true
  }

  /** yaml_emitter_write_indicator */
  indicator(s: string, needWhitespace: boolean, isWhitespace: boolean, isIndention: boolean) {
    if (needWhitespace && !this.whitespace) this.put(' ')
    this.put(s)
    this.whitespace = isWhitespace
    this.indention = this.indention && isIndention
  }
}

type Style = 'plain' | 'single' | 'double' | 'literal'

function selectStyle(s: string, cps: number[], a: Analysis, simpleKey: boolean): Style {
  // encoder.stringv
  let style: Style = s.includes('\n') ? 'literal' : resolvesToNonString(s) || BASE60_FLOAT.test(s) ? 'double' : 'plain'
  // yaml_emitter_select_scalar_style (block context, never canonical)
  if (simpleKey && a.multiline) style = 'double'
  if (style === 'plain') {
    if (!a.blockPlainAllowed) style = 'single'
    if (cps.length === 0 && simpleKey) style = 'single'
  }
  if (style === 'single' && !a.singleQuotedAllowed) style = 'double'
  if (style === 'literal' && (!a.blockAllowed || simpleKey)) style = 'double'
  return style
}

function writePlain(w: Writer, cps: number[], indent: number, allowBreaks: boolean) {
  if (!w.whitespace) w.put(' ')
  let spaces = false
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]
    if (isSpace(c)) {
      if (allowBreaks && !spaces && w.column > BEST_WIDTH && !isSpace(cps[i + 1])) {
        w.writeIndent(indent)
      } else {
        w.put(' ')
      }
      spaces = true
    } else {
      w.put(String.fromCodePoint(c))
      w.indention = false
      spaces = false
    }
  }
  w.whitespace = false
  w.indention = false
}

function writeSingle(w: Writer, cps: number[], indent: number, allowBreaks: boolean) {
  w.indicator("'", true, false, false)
  let spaces = false
  let breaks = false
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]
    if (isSpace(c)) {
      if (allowBreaks && !spaces && w.column > BEST_WIDTH && i > 0 && i < cps.length - 1 && !isSpace(cps[i + 1])) {
        w.writeIndent(indent)
      } else {
        w.put(' ')
      }
      spaces = true
    } else if (isBreak(c)) {
      // Not reached for the values we write: a break makes the scalar a
      // literal or double-quoted one. Kept for completeness.
      if (!breaks && c === 0x0a) w.breakLine()
      w.breakLine()
      w.indention = true
      breaks = true
    } else {
      if (breaks) w.writeIndent(indent)
      const ch = String.fromCodePoint(c)
      w.put(ch === "'" ? "''" : ch)
      w.indention = false
      spaces = false
      breaks = false
    }
  }
  w.indicator("'", false, false, false)
}

const ESCAPES: Record<number, string> = {
  0x00: '0', 0x07: 'a', 0x08: 'b', 0x09: 't', 0x0a: 'n', 0x0b: 'v', 0x0c: 'f', 0x0d: 'r', 0x1b: 'e',
  0x22: '"', 0x5c: '\\', 0x85: 'N', 0xa0: '_', 0x2028: 'L', 0x2029: 'P',
}

function hex(c: number, width: number): string {
  return c.toString(16).toUpperCase().padStart(width, '0')
}

function writeDouble(w: Writer, cps: number[], indent: number, allowBreaks: boolean) {
  w.indicator('"', true, false, false)
  let spaces = false
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]
    if (!isPrintable(c) || c === 0xfeff || isBreak(c) || c === 0x22 || c === 0x5c) {
      const e = ESCAPES[c]
      if (e !== undefined) w.put('\\' + e)
      else if (c <= 0xff) w.put('\\x' + hex(c, 2))
      else if (c <= 0xffff) w.put('\\u' + hex(c, 4))
      else w.put('\\U' + hex(c, 8))
      spaces = false
    } else if (isSpace(c)) {
      if (allowBreaks && !spaces && w.column > BEST_WIDTH && i !== 0 && i !== cps.length - 1) {
        w.writeIndent(indent)
        if (isSpace(cps[i + 1])) w.put('\\')
      } else {
        w.put(' ')
      }
      spaces = true
    } else {
      w.put(String.fromCodePoint(c))
      spaces = false
    }
  }
  w.indicator('"', false, false, false)
}

function writeLiteral(w: Writer, cps: number[], indent: number) {
  let hints = '|'
  if (isSpace(cps[0]) || isBreak(cps[0])) hints += String(BEST_INDENT)
  const last = cps.length - 1
  if (!isBreak(cps[last])) hints += '-'
  else if (last === 0 || isBreak(cps[last - 1])) hints += '+'
  w.indicator(hints, true, false, false)
  w.breakLine()
  w.indention = true
  w.whitespace = true
  let breaks = true
  for (const c of cps) {
    if (isBreak(c)) {
      w.breakLine()
      w.indention = true
      breaks = true
    } else {
      if (breaks) {
        w.writeIndent(indent)
        breaks = false
      }
      w.put(String.fromCodePoint(c))
      w.indention = false
    }
  }
}

function writeScalar(w: Writer, s: string, indent: number, simpleKey: boolean) {
  const cps = [...s].map((ch) => ch.codePointAt(0) as number)
  const a = analyze(cps)
  const allowBreaks = !simpleKey
  switch (selectStyle(s, cps, a, simpleKey)) {
    case 'plain': writePlain(w, cps, indent, allowBreaks); break
    case 'single': writeSingle(w, cps, indent, allowBreaks); break
    case 'double': writeDouble(w, cps, indent, allowBreaks); break
    case 'literal': writeLiteral(w, cps, indent); break
  }
}

/** A number, boolean or null as yaml.v2 writes it after JSON decoding. */
function writeAtom(w: Writer, v: number | boolean | null) {
  let s: string
  if (v === null) s = 'null'
  else if (typeof v === 'boolean') s = v ? 'true' : 'false'
  else if (!Number.isFinite(v)) throw new Error('YAML: non-finite number')
  else s = Number.isInteger(v) ? String(v) : formatFloat(v)
  if (!w.whitespace) w.put(' ')
  w.put(s)
  w.whitespace = false
  w.indention = false
}

/** strconv.FormatFloat(f, 'g', -1, 64), with yaml.v2's "+" exponent fix. */
function formatFloat(f: number): string {
  const exp = Math.floor(Math.log10(Math.abs(f)))
  if (exp < -4 || exp >= 6) {
    return f.toExponential().replace(/e([+-])(\d)$/, 'e$10$2')
  }
  return String(f)
}

// ---- key order: yaml.v2 keyList.Less ----

function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch)
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && /\p{Nd}/u.test(ch)
}

export function keyLess(a: string, b: string): boolean {
  const ar = [...a]
  const br = [...b]
  for (let i = 0; i < ar.length && i < br.length; i++) {
    if (ar[i] === br[i]) continue
    const al = isLetter(ar[i])
    const bl = isLetter(br[i])
    if (al && bl) return (ar[i].codePointAt(0) as number) < (br[i].codePointAt(0) as number)
    if (al || bl) return bl
    let an = 0
    let bn = 0
    if (ar[i] === '0' || br[i] === '0') {
      for (let j = i - 1; j >= 0 && isDigit(ar[j]); j--) {
        if (ar[j] !== '0') {
          an = 1
          bn = 1
          break
        }
      }
    }
    let ai = i
    let bi = i
    for (; ai < ar.length && isDigit(ar[ai]); ai++) an = an * 10 + (Number(ar[ai]) || 0)
    for (; bi < br.length && isDigit(br[bi]); bi++) bn = bn * 10 + (Number(br[bi]) || 0)
    if (an !== bn) return an < bn
    if (ai !== bi) return ai < bi
    return (ar[i].codePointAt(0) as number) < (br[i].codePointAt(0) as number)
  }
  return ar.length < br.length
}

function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (keyLess(a, b) ? -1 : keyLess(b, a) ? 1 : 0))
}

// ---- nodes ----

function isEmptyCollection(v: JsonValue): boolean {
  if (Array.isArray(v)) return v.length === 0
  return v !== null && typeof v === 'object' && sortedKeys(v).length === 0
}

/** Writes a mapping value or sequence item after its key or "- " (written
 *  at indent). In a mapping right after "key:", a sequence is written at the
 *  mapping's own indent ("indentless"), elsewhere one level deeper. */
function writeNode(w: Writer, v: JsonValue, indent: number, mappingContext: boolean) {
  if (Array.isArray(v)) {
    if (v.length === 0) return w.indicator('[]', true, false, false)
    writeSequence(w, v, mappingContext && !w.indention ? indent : indent + BEST_INDENT)
  } else if (v !== null && typeof v === 'object') {
    if (isEmptyCollection(v)) return w.indicator('{}', true, false, false)
    writeMapping(w, v, indent + BEST_INDENT)
  } else if (typeof v === 'string') {
    writeScalar(w, v, indent + BEST_INDENT, false)
  } else {
    writeAtom(w, v)
  }
}

/** yaml_emitter_check_simple_key for a scalar key: one line, at most 128 bytes. */
function isSimpleKey(k: string): boolean {
  return new TextEncoder().encode(k).length <= 128 && ![...k].some((ch) => isBreak(ch.codePointAt(0) as number))
}

function writeMapping(w: Writer, obj: { [key: string]: JsonValue | undefined }, indent: number) {
  for (const k of sortedKeys(obj)) {
    w.writeIndent(indent)
    if (isSimpleKey(k)) {
      writeScalar(w, k, indent + BEST_INDENT, true)
      w.indicator(':', false, false, false)
    } else {
      w.indicator('?', true, false, true)
      writeScalar(w, k, indent + BEST_INDENT, false)
      w.writeIndent(indent)
      w.indicator(':', true, false, true)
    }
    writeNode(w, obj[k] as JsonValue, indent, true)
  }
}

function writeSequence(w: Writer, items: JsonValue[], indent: number) {
  for (const item of items) {
    w.writeIndent(indent)
    w.indicator('-', true, false, true)
    writeNode(w, item, indent, false)
  }
}

/** The YAML document sigs.k8s.io/yaml.Marshal writes for v. */
export function toYaml(v: JsonValue): string {
  const w = new Writer()
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]\n'
    writeSequence(w, v, 0)
  } else if (v !== null && typeof v === 'object') {
    if (isEmptyCollection(v)) return '{}\n'
    writeMapping(w, v, 0)
  } else if (typeof v === 'string') {
    writeScalar(w, v, BEST_INDENT, false)
  } else {
    writeAtom(w, v)
  }
  if (!w.out.endsWith('\n')) w.breakLine()
  return w.out
}
