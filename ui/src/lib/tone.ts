/**
 * Colour tones for badges and pills. Tailwind only emits classes it can see as
 * whole strings in the source, so every class is spelled out here; this file is
 * the one place a tone's colours live.
 *
 *  - soft:   bg-X-500/10 text-X-300 border-X-500/30 (inline status pills)
 *  - strong: bg-X-500/20 text-X-400 border-X-500/30 (phase pills)
 *  - muted:  bg-X-500/20 text-X-500 border-X-500/30 (de-emphasised phase pills)
 */
export type Tone = 'gray' | 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'purple' | 'indigo' | 'cyan' | 'sky' | 'amber' | 'emerald'
export type ToneStrength = 'soft' | 'strong' | 'muted'

export const TONES: readonly Tone[] = ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'indigo', 'cyan', 'sky', 'amber', 'emerald']

const CLASSES: Record<Tone, Record<ToneStrength, string>> = {
  gray: {
    soft: 'border-gray-500/30 bg-gray-500/10 text-gray-300',
    strong: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    muted: 'bg-gray-500/20 text-gray-500 border-gray-500/30',
  },
  blue: {
    soft: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
    strong: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    muted: 'bg-blue-500/20 text-blue-500 border-blue-500/30',
  },
  green: {
    soft: 'border-green-500/30 bg-green-500/10 text-green-300',
    strong: 'bg-green-500/20 text-green-400 border-green-500/30',
    muted: 'bg-green-500/20 text-green-500 border-green-500/30',
  },
  yellow: {
    soft: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-300',
    strong: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    muted: 'bg-yellow-500/20 text-yellow-500 border-yellow-500/30',
  },
  orange: {
    soft: 'border-orange-500/30 bg-orange-500/10 text-orange-300',
    strong: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    muted: 'bg-orange-500/20 text-orange-500 border-orange-500/30',
  },
  red: {
    soft: 'border-red-500/30 bg-red-500/10 text-red-300',
    strong: 'bg-red-500/20 text-red-400 border-red-500/30',
    muted: 'bg-red-500/20 text-red-500 border-red-500/30',
  },
  purple: {
    soft: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
    strong: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    muted: 'bg-purple-500/20 text-purple-500 border-purple-500/30',
  },
  indigo: {
    soft: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
    strong: 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
    muted: 'bg-indigo-500/20 text-indigo-500 border-indigo-500/30',
  },
  cyan: {
    soft: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
    strong: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
    muted: 'bg-cyan-500/20 text-cyan-500 border-cyan-500/30',
  },
  sky: {
    soft: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    strong: 'bg-sky-500/20 text-sky-400 border-sky-500/30',
    muted: 'bg-sky-500/20 text-sky-500 border-sky-500/30',
  },
  amber: {
    soft: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    strong: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    muted: 'bg-amber-500/20 text-amber-500 border-amber-500/30',
  },
  emerald: {
    soft: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    strong: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    muted: 'bg-emerald-500/20 text-emerald-500 border-emerald-500/30',
  },
}

export function toneClasses(tone: Tone, strength: ToneStrength = 'soft'): string {
  return CLASSES[tone][strength]
}
