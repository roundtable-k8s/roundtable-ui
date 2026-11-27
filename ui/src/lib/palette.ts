// Command palette entries and ranking (#479). Pure, no React.

export type PaletteKind = 'page' | 'knight' | 'chain' | 'schedule' | 'mission' | 'trigger'

export interface PaletteEntry {
  kind: PaletteKind
  label: string
  sub: string
  to: string
}

export const MAX_RESULTS = 20

interface Named { name: string; namespace?: string; domain?: string; phase?: string; table?: string }

export interface PaletteSources {
  knights?: Named[]
  chains?: Named[]
  schedules?: Named[]
  missions?: Named[]
  triggers?: Named[]
  pages?: { path: string; label: string }[]
}

const enc = encodeURIComponent
const nsSub = (x: Named, extra?: string) => [x.namespace, extra].filter(Boolean).join(' · ')

export function buildEntries(s: PaletteSources): PaletteEntry[] {
  const out: PaletteEntry[] = []
  for (const p of s.pages ?? []) out.push({ kind: 'page', label: p.label, sub: p.path, to: p.path })
  for (const k of s.knights ?? []) out.push({ kind: 'knight', label: k.name, sub: nsSub(k, k.domain), to: `/fleet?knight=${enc(k.name)}` })
  for (const c of s.chains ?? []) out.push({ kind: 'chain', label: c.name, sub: nsSub(c, c.phase), to: `/chains?chain=${enc(c.name)}` })
  for (const x of s.schedules ?? []) out.push({ kind: 'schedule', label: x.name, sub: nsSub(x), to: `/schedules/${enc(x.namespace ?? '')}/${enc(x.name)}` })
  for (const m of s.missions ?? []) out.push({ kind: 'mission', label: m.name, sub: nsSub(m, m.phase), to: `/missions/${enc(m.name)}` })
  for (const t of s.triggers ?? []) out.push({ kind: 'trigger', label: t.name, sub: nsSub(t), to: `/triggers/${enc(t.namespace ?? '')}/${enc(t.name)}` })
  return out
}

/** 0 = no match; 3 name word-start/prefix, 2 name substring, 1 sub-text match. */
function score(text: string, q: string): number {
  const t = text.toLowerCase()
  const i = t.indexOf(q)
  if (i < 0) return 0
  return i === 0 || /[\s\-_./:·]/.test(t[i - 1]) ? 3 : 2
}

/** Empty query: the pages. Otherwise name matches before sub-text, stable order, at most 20. */
export function rank(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries.filter(e => e.kind === 'page').slice(0, MAX_RESULTS)
  const scored: { e: PaletteEntry; s: number; i: number }[] = []
  entries.forEach((e, i) => {
    const s = score(e.label, q) || (score(e.sub, q) ? 1 : 0)
    if (s) scored.push({ e, s, i })
  })
  scored.sort((a, b) => b.s - a.s || a.i - b.i)
  return scored.slice(0, MAX_RESULTS).map(x => x.e)
}
