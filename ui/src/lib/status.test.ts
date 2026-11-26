import { describe, it, expect } from 'vitest'
import { phaseColor } from './status'

const PENDING = phaseColor('Pending')

// Phases the CRDs (and the comments in types.ts / useFleet.ts) name.
const KNOWN: Record<string, string> = {
  Pending: 'gray', Idle: 'gray', Unknown: 'gray', Skipped: 'gray', Expired: 'gray',
  Provisioning: 'blue', Running: 'blue', StepRunning: 'blue', Active: 'blue',
  Planning: 'indigo', Assembling: 'cyan', Briefing: 'purple',
  Ready: 'green', Succeeded: 'green', Completed: 'green',
  Degraded: 'yellow', PartiallySucceeded: 'yellow',
  Paused: 'orange', Suspended: 'orange', CleaningUp: 'orange', OverBudget: 'orange',
  Failed: 'red', Error: 'red',
}

describe('phaseColor', () => {
  it.each(Object.entries(KNOWN))('%s maps to a %s badge', (phase, colour) => {
    expect(phaseColor(phase)).toContain(`bg-${colour}-500/20`)
  })

  it('falls back to Pending for an unknown or empty phase', () => {
    expect(phaseColor('Bogus')).toBe(PENDING)
    expect(phaseColor('')).toBe(PENDING)
  })

  it('is case sensitive: a mis-cased phase falls back', () => {
    expect(phaseColor('failed')).toBe(PENDING)
  })
})
