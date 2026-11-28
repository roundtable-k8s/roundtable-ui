import { describe, it, expect } from 'vitest'
import { TONES, toneClasses } from './tone'
import { PHASE_COLORS, phaseColor } from './status'

// phaseColor output before Badge/tone existed; must never change.
const SNAPSHOT: Record<string, string> = {
  'Idle': 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  'Pending': 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  'Unknown': 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  'Skipped': 'bg-gray-500/20 text-gray-500 border-gray-500/30',
  'Expired': 'bg-gray-500/20 text-gray-500 border-gray-500/30',
  'Provisioning': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'Running': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'StepRunning': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'Active': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  'Planning': 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30',
  'Assembling': 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  'Briefing': 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  'Ready': 'bg-green-500/20 text-green-400 border-green-500/30',
  'Succeeded': 'bg-green-500/20 text-green-400 border-green-500/30',
  'Completed': 'bg-green-500/20 text-green-400 border-green-500/30',
  'Degraded': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  'PartiallySucceeded': 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  'Paused': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'Suspended': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'CleaningUp': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'OverBudget': 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  'Failed': 'bg-red-500/20 text-red-400 border-red-500/30',
  'Error': 'bg-red-500/20 text-red-400 border-red-500/30',
  'Bogus': 'bg-gray-500/20 text-gray-400 border-gray-500/30'
}

describe('toneClasses', () => {
  it.each(TONES)('%s yields bg, text and border classes at every strength', (tone) => {
    for (const strength of ['soft', 'strong', 'muted'] as const) {
      const c = toneClasses(tone, strength)
      expect(c).toContain(`bg-${tone}-500/`)
      expect(c).toContain(`text-${tone}-`)
      expect(c).toContain(`border-${tone}-500/30`)
    }
  })
  it('defaults to soft', () => {
    expect(toneClasses('amber')).toBe('border-amber-500/30 bg-amber-500/10 text-amber-300')
  })
})

describe('phaseColor', () => {
  it('covers every phase in PHASE_COLORS', () => {
    expect(Object.keys(SNAPSHOT).filter(k => k !== 'Bogus').sort()).toEqual(Object.keys(PHASE_COLORS).sort())
  })
  it.each(Object.entries(SNAPSHOT))('%s is byte-identical to the pre-refactor class string', (phase, classes) => {
    expect(phaseColor(phase)).toBe(classes)
  })
})
