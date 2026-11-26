import { describe, it, expect } from 'vitest'
import {
  buildRequest, buildSpec, emptyForm, fieldMessage, formFieldFor, formFromManifest, manifestYaml,
  CALLER_ANNOTATION, GATEWAY_LABEL, GATEWAY_LABEL_VALUE, type ScheduleForm, type TriggerManifest,
} from './scheduleForm'
// Recorded with the gateway's own manifest code (roundtable 7c2bfd4,
// internal/gateway scheduleManifest) for Triggers created through the
// gateway by the caller "dashboard", with the API server's CRD defaults
// applied. The .json files are the same manifests as
// GET /api/schedules/{namespace}/{name}/manifest?format=json returns them.
import knightYaml from './__fixtures__/schedule-manifests/knight.yaml?raw'
import chainYaml from './__fixtures__/schedule-manifests/chain.yaml?raw'
import missionYaml from './__fixtures__/schedule-manifests/mission.yaml?raw'
import knightJson from './__fixtures__/schedule-manifests/knight.json?raw'
import chainJson from './__fixtures__/schedule-manifests/chain.json?raw'
import missionJson from './__fixtures__/schedule-manifests/mission.json?raw'

/** What the gateway adds to a schedule the dashboard creates. */
const savedByDashboard = { labels: { [GATEWAY_LABEL]: GATEWAY_LABEL_VALUE }, annotations: { [CALLER_ANNOTATION]: 'dashboard' } }

const knightForm: ScheduleForm = {
  ...emptyForm('roundtable'), name: 'morning-brief', table: 'fleet-a', kind: 'knight', knight: 'galahad',
  task: 'Summarise the overnight alerts.\nList anything still firing: "critical" first.',
  cron: '0 7 * * 1-5', timeZone: 'Europe/Berlin', concurrency: 'Forbid',
}
const chainForm: ScheduleForm = {
  ...emptyForm('roundtable'), name: 'nightly-digest', kind: 'chain', chain: 'daily-digest',
  input: 'Digest for {{ .Event.Time.Format "2006-01-02" }}', cron: '30 2 * * *', timeZone: 'UTC', concurrency: 'Allow', suspend: true,
}
const missionForm: ScheduleForm = {
  ...emptyForm('roundtable'), name: 'weekly-review', table: 'fleet-a', kind: 'mission',
  objective: "Review last week's incidents: #1 priority is anything that paged twice, then summarise the follow-ups that are still open and who owns them",
  costBudgetUSD: '5.00', cron: '0 9 * * 1', timeZone: 'America/New_York', concurrency: 'Allow',
}

describe('YAML preview', () => {
  it.each([
    ['knight', knightForm, knightYaml],
    ['chain', chainForm, chainYaml],
    ['mission', missionForm, missionYaml],
  ])('equals the recorded manifest for a %s target', (_, form, want) => {
    expect(manifestYaml(form, undefined, savedByDashboard)).toBe(want)
  })

  it('has no gateway label or caller annotation for a new schedule (YAML to commit to Git)', () => {
    const y = manifestYaml(knightForm)
    expect(y).not.toContain('labels:')
    expect(y).not.toContain('annotations:')
    expect(y.startsWith('apiVersion: ai.roundtable.io/v1alpha1\nkind: Trigger\nmetadata:\n  name: morning-brief\n  namespace: roundtable\nspec:\n')).toBe(true)
  })

  it.each([
    ['knight', knightJson, knightYaml],
    ['chain', chainJson, chainYaml],
    ['mission', missionJson, missionYaml],
  ])('round-trips an unchanged %s schedule to its manifest when editing', (_, json, want) => {
    const base = JSON.parse(json) as TriggerManifest
    expect(manifestYaml(formFromManifest(base), base)).toBe(want)
  })
})

describe('buildSpec', () => {
  it('keeps fields the form does not show when editing', () => {
    const base = {
      source: { schedule: { cron: '0 7 * * *', timeZone: 'UTC', startingDeadlineSeconds: 300 } },
      target: { knight: { name: 'galahad', task: 'old', model: 'opus', timeoutSeconds: 600 } },
      dedupeKey: '{{ .Event.Time }}', concurrency: { policy: 'Allow', maxActive: 2 }, ttlSecondsAfterFinished: 0,
    }
    const spec = buildSpec({ ...emptyForm('roundtable'), kind: 'knight', knight: 'percival', task: 'new', cron: '0 8 * * *', concurrency: 'Forbid' }, base)
    expect(spec).toEqual({
      source: { schedule: { cron: '0 8 * * *', timeZone: 'UTC', startingDeadlineSeconds: 300 } },
      target: { knight: { name: 'percival', task: 'new', model: 'opus', timeoutSeconds: 600 } },
      dedupeKey: '{{ .Event.Time }}', concurrency: { policy: 'Forbid', maxActive: 2 }, ttlSecondsAfterFinished: 0,
    })
  })

  it('drops the old target and input when the target kind changes', () => {
    const base = { source: { schedule: { cron: '* * * * *' } }, target: { chainRef: { name: 'c' } }, input: 'x' }
    const spec = buildSpec({ ...missionForm }, base)
    expect(spec.target).toEqual({ mission: { objective: missionForm.objective, costBudgetUSD: '5.00', metaMission: true } })
    expect(spec.input).toBeUndefined()
  })

  it('builds the request body', () => {
    expect(buildRequest({ ...chainForm, name: ' nightly-digest ', input: '', suspend: false, table: 'fleet-b' })).toEqual({
      name: 'nightly-digest', namespace: 'roundtable',
      spec: {
        source: { schedule: { cron: '30 2 * * *', timeZone: 'UTC' } }, target: { chainRef: { name: 'daily-digest' } },
        concurrency: { policy: 'Allow' }, roundTableRef: { name: 'fleet-b' }, ttlSecondsAfterFinished: 86400,
      },
    })
  })
})

describe('gateway field errors', () => {
  it.each([
    ['name', 'name'],
    ['spec.source.schedule.cron', 'cron'],
    ['spec.source.schedule.timeZone', 'timeZone'],
    ['spec.source.schedule.startingDeadlineSeconds', 'cron'],
    ['spec.target.knight.name', 'knight'],
    ['spec.target.knight.task', 'task'],
    ['spec.target.chainRef.name', 'chain'],
    ['spec.target.mission.objective', 'objective'],
    ['spec.target.mission.costBudgetUSD', 'costBudgetUSD'],
    ['spec.target', 'kind'],
    ['spec.input', 'input'],
    ['spec.roundTableRef.name', 'table'],
    ['spec.concurrency.policy', 'concurrency'],
    ['spec.dedupeKey', ''],
    [undefined, ''],
  ])('maps %s to the %s field', (field, want) => {
    expect(formFieldFor(field)).toBe(want)
  })

  it('strips the field prefix from the message', () => {
    expect(fieldMessage('invalid request: spec.source.schedule.cron: "every day" is not a valid cron expression', 'spec.source.schedule.cron'))
      .toBe('"every day" is not a valid cron expression')
  })
})
