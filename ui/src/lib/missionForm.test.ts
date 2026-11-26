import { describe, it, expect } from 'vitest'
import { validateMissionForm, firstInvalidStep, type MissionFormValues } from './missionForm'

const ok: MissionFormValues = {
  name: 'code-review',
  objective: 'do it',
  costBudgetUSD: '1.00',
  ttl: '3600',
  timeout: '300',
  knights: [{ name: 'a' }],
  metaMission: false,
  planner: { timeout: '300', maxChains: '5', maxKnights: '10' },
}
const v = (o: Partial<MissionFormValues>) => validateMissionForm({ ...ok, ...o })

describe('validateMissionForm', () => {
  it('accepts a valid form', () => expect(v({})).toEqual({}))
  it('rejects bad names', () => {
    for (const name of ['', 'Upper', '-a', 'a-', 'a b', 'a_b', 'a'.repeat(64)]) expect(v({ name }).name).toBeTruthy()
    for (const name of ['a', 'a-b', 'a'.repeat(63)]) expect(v({ name }).name).toBeUndefined()
  })
  it('checks the objective after trim', () => {
    expect(v({ objective: '   ' }).objective).toBeTruthy()
    expect(v({ objective: 'x'.repeat(1001) }).objective).toBeTruthy()
    expect(v({ objective: 'x'.repeat(1000) }).objective).toBeUndefined()
  })
  it('checks TTL and timeout ranges and empties', () => {
    expect(v({ ttl: '' }).ttl).toBe('TTL must be between 60 and 604800 seconds')
    expect(v({ ttl: '59' }).ttl).toBeTruthy()
    expect(v({ ttl: '604801' }).ttl).toBeTruthy()
    expect(v({ ttl: '1.5' }).ttl).toBeTruthy()
    expect(v({ ttl: '60' }).ttl).toBeUndefined()
    expect(v({ timeout: '' }).timeout).toBe('Timeout must be between 60 and 86400 seconds')
    expect(v({ timeout: '86401' }).timeout).toBeTruthy()
    expect(v({ timeout: '86400' }).timeout).toBeUndefined()
  })
  it('checks the budget', () => {
    for (const b of ['abc', '-5', '0', '0.00', '1.234', '', '1e3']) expect(v({ costBudgetUSD: b }).costBudgetUSD).toBeTruthy()
    for (const b of ['1', '1.5', '0.25', '10.00']) expect(v({ costBudgetUSD: b }).costBudgetUSD).toBeUndefined()
  })
  it('needs a knight unless meta-mission, and no duplicates', () => {
    expect(v({ knights: [{ name: ' ' }] }).knights).toBeTruthy()
    expect(v({ knights: [{ name: ' ' }], metaMission: true }).knights).toBeUndefined()
    const e = v({ knights: [{ name: 'a' }, { name: 'b' }, { name: 'a ' }] })
    expect(e['knights.2']).toBeTruthy()
    expect(e['knights.0']).toBeUndefined()
  })
  it('checks planner numbers only for meta-missions', () => {
    const planner = { timeout: '', maxChains: '0', maxKnights: '51' }
    expect(Object.keys(v({ planner }))).toEqual([])
    expect(Object.keys(v({ planner, metaMission: true })).sort()).toEqual(['planner.maxChains', 'planner.maxKnights', 'planner.timeout'])
  })
})

describe('firstInvalidStep', () => {
  it('maps errors to steps', () => {
    expect(firstInvalidStep({})).toBe(-1)
    expect(firstInvalidStep({ knights: 'x' })).toBe(1)
    expect(firstInvalidStep({ 'planner.timeout': 'x' })).toBe(2)
    expect(firstInvalidStep({ 'planner.timeout': 'x', ttl: 'y' })).toBe(0)
  })
})
