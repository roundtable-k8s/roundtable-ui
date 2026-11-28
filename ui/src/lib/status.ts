/**
 * Single source of truth for phase → badge colors across every resource
 * (Mission, Chain, ChainStep, RoundTable, Knight). Previously each page
 * carried its own partial, drifting copy of this map.
 */

import { toneClasses, type Tone, type ToneStrength } from './tone'

interface PhaseStyle { tone: Tone; strength: ToneStrength }

const GRAY: PhaseStyle = { tone: 'gray', strength: 'strong' }
const DIM: PhaseStyle = { tone: 'gray', strength: 'muted' }
const strong = (tone: Tone): PhaseStyle => ({ tone, strength: 'strong' })

export const PHASE_COLORS: Record<string, PhaseStyle> = {
  // Waiting / neutral
  Idle: GRAY,
  Pending: GRAY,
  Unknown: GRAY,
  Skipped: DIM,
  Expired: DIM,

  // In progress
  Provisioning: strong('blue'),
  Running: strong('blue'),
  StepRunning: strong('blue'),
  Active: strong('blue'),
  Planning: strong('indigo'),
  Assembling: strong('cyan'),
  Briefing: strong('purple'),

  // Healthy / done
  Ready: strong('green'),
  Succeeded: strong('green'),
  Completed: strong('green'), // legacy alias

  // Degraded
  Degraded: strong('yellow'),
  PartiallySucceeded: strong('yellow'),

  // Paused / cleanup
  Paused: strong('orange'),
  Suspended: strong('orange'),
  CleaningUp: strong('orange'),
  OverBudget: strong('orange'),

  // Failed
  Failed: strong('red'),
  Error: strong('red'),
}

/** Tone and strength for a phase; unknown phases fall back to Pending. */
export function phaseStyle(phase: string): PhaseStyle {
  return PHASE_COLORS[phase] || PHASE_COLORS.Pending
}

export function phaseColor(phase: string): string {
  const { tone, strength } = phaseStyle(phase)
  return toneClasses(tone, strength)
}

/** Knight liveness dot colors (KnightCard pulsing indicator). */
export const KNIGHT_STATUS_DOT: Record<string, string> = {
  online: 'bg-green-500',
  offline: 'bg-red-500',
  starting: 'bg-yellow-500',
  busy: 'bg-blue-500',
  'scaled-to-zero': 'bg-gray-500',
}
