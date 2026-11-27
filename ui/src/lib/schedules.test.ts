import { describe, it, expect } from 'vitest'
import { describeDeadline, describeSuspension, describePolicy, phaseToOutcome, filterSchedules, formatCostUSD, formatSeconds, isFailing, runResultText, runResultOutcome, describeTurns, prLabel, scheduleApi, scheduleLink, sortRunsNewestFirst, type Schedule } from './schedules'

describe('schedules helpers', () => {
  it('builds encoded API paths and links', () => {
    expect(scheduleApi('roundtable', 'a b', 'runs', 'r/1')).toBe('/api/schedules/roundtable/a%20b/runs/r%2F1')
    expect(scheduleLink('roundtable', 'digest')).toBe('/schedules/roundtable/digest')
  })

  it('formats duration and cost, with a dash when unknown', () => {
    expect(formatSeconds(undefined)).toBe('—')
    expect(formatSeconds(31)).toBe('31s')
    expect(formatSeconds(212.4)).toBe('3m 32s')
    expect(formatSeconds(3725)).toBe('1h 2m')
    expect(formatCostUSD(undefined)).toBe('—')
    expect(formatCostUSD('0.41')).toBe('$0.41')
    expect(formatCostUSD('0.0012')).toBe('$0.0012')
    expect(formatCostUSD('n/a')).toBe('—')
  })

  it('sorts runs newest first', () => {
    const sorted = sortRunsNewestFirst([
      { time: '2026-11-23T07:00:00Z', outcome: 'failed', resultAvailable: true },
      { time: '2026-11-25T07:00:00Z', outcome: 'succeeded', resultAvailable: true },
    ])
    expect(sorted.map((r) => r.outcome)).toEqual(['succeeded', 'failed'])
  })

  it('uses the final output, else every step output or error', () => {
    expect(runResultText({ schedule: 's', target: 'chain', run: 'r', phase: 'Succeeded', output: 'done' })).toBe('done')
    expect(runResultText({
      schedule: 's', target: 'chain', run: 'r', phase: 'Failed',
      steps: [{ name: 'a', output: 'A' }, { name: 'b', error: 'boom' }, { name: 'c' }],
    })).toBe('## a\n\nA\n\n## b\n\nError: boom')
  })
})

describe('knight and mission results', () => {
  const base = { schedule: 's', run: 'r' }
  it('reads the task output, else its error', () => {
    expect(runResultText({ ...base, target: 'knight', task: { output: 'out', error: 'e' } })).toBe('out')
    expect(runResultText({ ...base, target: 'knight', task: { error: 'e' } })).toBe('e')
    expect(runResultText({ ...base, target: 'knight' })).toBe('')
  })
  it('reads the mission result', () => {
    expect(runResultText({ ...base, target: 'mission', mission: { result: 'res' } })).toBe('res')
    expect(runResultText({ ...base, target: 'mission', mission: { phase: 'Failed' } })).toBe('')
  })
  it('falls back to task status or mission phase for the outcome', () => {
    expect(runResultOutcome({ ...base, target: 'knight', task: { status: 'Failed' } })).toBe('failed')
    expect(runResultOutcome({ ...base, target: 'mission', mission: { phase: 'Succeeded' } })).toBe('succeeded')
    expect(runResultOutcome({ ...base, target: 'chain', phase: 'Running', task: { status: 'Failed' } })).toBe('running')
    expect(runResultOutcome({ ...base, target: 'chain' })).toBe('unknown')
  })
  it('describes turns and tool calls, leaving unreported ones out', () => {
    expect(describeTurns({ turns: 3, toolCalls: 12 })).toBe('3 turns · 12 tool calls')
    expect(describeTurns({ turns: 1, toolCalls: 0 })).toBe('1 turn · 0 tool calls')
    expect(describeTurns({ turns: 2 })).toBe('2 turns')
    expect(describeTurns({})).toBe('')
  })
})

describe('prLabel', () => {
  it('joins repo and number', () => {
    expect(prLabel({ repo: 'o/r', number: 4 })).toBe('o/r#4')
    expect(prLabel({ repo: 'o/r' })).toBe('o/r')
    expect(prLabel({})).toBe('')
  })
})

describe('phaseToOutcome', () => {
  it('lower-camels any run phase', () => {
    expect(phaseToOutcome('Succeeded')).toBe('succeeded')
    expect(phaseToOutcome('PartiallySucceeded')).toBe('partiallySucceeded')
    expect(phaseToOutcome('Running')).toBe('running')
    expect(phaseToOutcome('')).toBe('unknown')
  })
})

describe('schedule policy helpers', () => {
  it('describes the concurrency policy, with the cap when set', () => {
    expect(describePolicy({ concurrency: { policy: 'Forbid' } })).toBe('Forbid')
    expect(describePolicy({ concurrency: { policy: 'Allow', maxActive: 3 } })).toBe('Allow, up to 3 active')
    expect(describePolicy({ concurrency: { policy: 'Allow', maxActive: 0 } })).toBe('Allow')
    expect(describePolicy({})).toBe('')
  })

  it('describes the suspension source from the gateway value', () => {
    expect(describeSuspension({})).toBe('')
    expect(describeSuspension({ suspendedBy: '' })).toBe('')
    expect(describeSuspension({ suspendedBy: 'annotation' })).toBe('annotation')
    expect(describeSuspension({ suspendedBy: 'spec' })).toBe('spec')
    expect(describeSuspension({ suspendedBy: 'spec,annotation' })).toBe('spec and annotation')
    expect(describeSuspension({ suspendedBy: ' spec , annotation ,' })).toBe('spec and annotation')
  })

  it('describes the starting deadline, none when unset', () => {
    expect(describeDeadline({})).toBe('none')
    expect(describeDeadline({ startingDeadlineSeconds: 0 })).toBe('0s')
    expect(describeDeadline({ startingDeadlineSeconds: 300 })).toBe('5m 0s')
  })
})

describe('filterSchedules', () => {
  const base = { name: 's', namespace: 'roundtable', cron: '0 7 * * *', timeZone: 'UTC', target: { kind: 'chain', summary: 'c' }, managedBy: 'api' } as const
  const list: Schedule[] = [
    { ...base, name: 'live', suspended: false, lastResult: { time: 't', outcome: 'succeeded' } },
    { ...base, name: 'paused', suspended: true },
    { ...base, name: 'broken', suspended: false, lastResult: { time: 't', outcome: 'failed' } },
    { ...base, name: 'lost', suspended: true, lastResult: { time: 't', outcome: 'lost' } },
    { ...base, name: 'fresh', suspended: false, lastResult: { time: 't', outcome: 'skipped' } },
    { ...base, name: 'new', suspended: false },
  ]
  const names = (l: Schedule[]) => l.map((s) => s.name)

  it('returns everything for all and for an unknown state', () => {
    expect(names(filterSchedules(list, 'all'))).toHaveLength(6)
    expect(names(filterSchedules(list, 'bogus'))).toHaveLength(6)
  })

  it('active is the schedules that are not suspended', () => {
    expect(names(filterSchedules(list, 'active'))).toEqual(['live', 'broken', 'fresh', 'new'])
  })

  it('suspended is the suspended schedules', () => {
    expect(names(filterSchedules(list, 'suspended'))).toEqual(['paused', 'lost'])
  })

  it('failing is a last firing that failed or was lost, and skips schedules with no last result', () => {
    expect(names(filterSchedules(list, 'failing'))).toEqual(['broken', 'lost'])
    expect(isFailing({ ...base, suspended: false })).toBe(false)
  })
})
