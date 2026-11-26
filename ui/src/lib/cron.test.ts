import { describe, it, expect } from 'vitest'
import { CronError, isValidTimeZone, nextRuns, parseCron } from './cron'

const iso = (ds: Date[]) => ds.map((d) => d.toISOString())

describe('parseCron', () => {
  it('reads ranges, steps, lists and names', () => {
    const s = parseCron('*/20 9-17/4 1,15 JAN-mar mon-FRI')
    if (s.kind !== 'cron') throw new Error('not cron')
    expect(s.minute.values).toEqual([0, 20, 40])
    expect(s.hour.values).toEqual([9, 13, 17])
    expect(s.dom).toEqual({ values: [1, 15], star: false })
    expect(s.month.values).toEqual([1, 2, 3])
    expect(s.dow.values).toEqual([1, 2, 3, 4, 5])
  })

  it('treats N/step as N-max/step and */step as no star', () => {
    const s = parseCron('5/30 * */2 * *')
    if (s.kind !== 'cron') throw new Error('not cron')
    expect(s.minute.values).toEqual([5, 35])
    expect(s.dom.star).toBe(false)
  })

  it.each([
    ['', /empty/],
    ['* * * *', /expected 5 fields/],
    ['60 * * * *', /minute: 60 is above/],
    ['* * * * 7', /day of week: 7 is above/],
    ['* * 0 * *', /day of month: 0 is below/],
    ['5-1 * * * *', /5 is after 1/],
    ['*/0 * * * *', /step must be at least 1/],
    ['x * * * *', /"x" is not a number/],
    ['TZ=UTC 0 7 * * *', /TZ= prefix/],
    ['@fortnightly', /unknown descriptor/],
    ['@every soon', /not a duration/],
  ])('rejects %j', (expr, msg) => {
    expect(() => parseCron(expr)).toThrow(CronError)
    expect(() => parseCron(expr)).toThrow(msg)
  })
})

describe('nextRuns', () => {
  const from = new Date('2026-11-25T18:30:00Z') // a Wednesday

  it('lists the next three runs in UTC', () => {
    expect(iso(nextRuns('0 7 * * 1-5', 'UTC', from))).toEqual([
      '2026-11-26T07:00:00.000Z', '2026-11-27T07:00:00.000Z', '2026-11-30T07:00:00.000Z',
    ])
  })

  it('evaluates the cron in the chosen time zone', () => {
    // 07:00 in Berlin is 06:00 UTC in winter; in New York 12:00 UTC.
    expect(iso(nextRuns('0 7 * * *', 'Europe/Berlin', from, 2))).toEqual(['2026-11-26T06:00:00.000Z', '2026-11-27T06:00:00.000Z'])
    expect(iso(nextRuns('0 7 * * *', 'America/New_York', from, 1))).toEqual(['2026-11-26T12:00:00.000Z'])
  })

  it('excludes the start time itself', () => {
    expect(iso(nextRuns('30 18 * * *', 'UTC', from, 1))).toEqual(['2026-11-26T18:30:00.000Z'])
  })

  it('matches day of month OR day of week when neither is *', () => {
    // The 1st of the month, or any Friday.
    expect(iso(nextRuns('0 0 1 * 5', 'UTC', from))).toEqual([
      '2026-11-27T00:00:00.000Z', '2026-12-01T00:00:00.000Z', '2026-12-04T00:00:00.000Z',
    ])
  })

  it('skips a wall time a DST change leaves out and repeats one it doubles', () => {
    // Berlin: 2027-03-28 02:00 -> 03:00, 2027-10-31 03:00 -> 02:00.
    expect(iso(nextRuns('30 2 28 3 *', 'Europe/Berlin', new Date('2027-03-01T00:00:00Z'), 1))).toEqual(['2028-03-28T00:30:00.000Z'])
    expect(iso(nextRuns('30 2 31 10 *', 'Europe/Berlin', new Date('2027-10-01T00:00:00Z'), 2))).toEqual([
      '2027-10-31T00:30:00.000Z', '2027-10-31T01:30:00.000Z',
    ])
  })

  it('reads descriptors and @every', () => {
    expect(iso(nextRuns('@daily', 'UTC', from, 1))).toEqual(['2026-11-26T00:00:00.000Z'])
    expect(iso(nextRuns('@every 1h30m', 'UTC', from, 2))).toEqual(['2026-11-25T20:00:00.000Z', '2026-11-25T21:30:00.000Z'])
  })

  it('finds a leap day years ahead and nothing for an impossible date', () => {
    expect(iso(nextRuns('0 12 29 2 *', 'UTC', from, 1))).toEqual(['2028-02-29T12:00:00.000Z'])
    expect(nextRuns('0 0 31 2 *', 'UTC', from)).toEqual([])
  })

  it('rejects an unknown or Local time zone', () => {
    expect(() => nextRuns('0 7 * * *', 'Mars/Olympus', from)).toThrow(/not an IANA time zone/)
    expect(isValidTimeZone('Local')).toBe(false)
    expect(isValidTimeZone('Europe/Berlin')).toBe(true)
  })
})
