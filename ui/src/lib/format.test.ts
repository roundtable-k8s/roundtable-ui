import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  budgetText, countLabel, formatCost, formatDateTime, formatDay, formatNumber, formatAge, formatDuration, formatMsLadder, formatRelativeTime,
  formatSecondsLadder, formatTimestamp, formatTimestampOrDate, formatUptime, until,
} from './format'

const NOW = new Date('2026-06-10T12:00:00Z').getTime()
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString()
const ahead = (sec: number) => new Date(NOW + sec * 1000).toISOString()

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW) })
afterEach(() => { vi.useRealTimers() })

describe('formatCost', () => {
  it('shows 4 decimals under a cent and 2 otherwise', () => {
    expect(formatCost(0)).toBe('$0.0000')
    expect(formatCost(0.00421)).toBe('$0.0042')
    expect(formatCost(0.01)).toBe('$0.01')
    expect(formatCost(1.234)).toBe('$1.23')
  })

  it('follows the given locale', () => {
    expect(formatCost(1234.5, 'en-US')).toBe('$1,234.50')
    expect(formatCost(1234.5, 'de-DE')).toBe('1.234,50\u00a0$')
    expect(formatCost(0.00421, 'en-US')).toBe('$0.0042')
  })
})

describe('budgetText', () => {
  it('reads empty, zero and non-numeric budgets as unlimited', () => {
    expect(budgetText('')).toBe('unlimited')
    expect(budgetText('0')).toBe('unlimited')
    expect(budgetText('0.00')).toBe('unlimited')
    expect(budgetText('abc')).toBe('unlimited')
    expect(budgetText(undefined)).toBe('unlimited')
  })
  it('formats a positive budget as a dollar amount', () => {
    expect(budgetText('50')).toBe('$50.00')
    expect(budgetText('0.005')).toBe('$0.0050')
  })
})

describe('formatSecondsLadder', () => {
  it('handles the 59/60 and 3599/3600 boundaries', () => {
    expect(formatSecondsLadder(0)).toBe('0s')
    expect(formatSecondsLadder(59)).toBe('59s')
    expect(formatSecondsLadder(60)).toBe('1m 0s')
    expect(formatSecondsLadder(3599)).toBe('59m 59s')
    expect(formatSecondsLadder(3600)).toBe('1h 0m')
    expect(formatSecondsLadder(7500)).toBe('2h 5m')
  })
  it('rounds to the nearest second', () => {
    expect(formatSecondsLadder(212.4)).toBe('3m 32s')
    expect(formatSecondsLadder(59.6)).toBe('1m 0s')
  })
  it('gives a dash for null, negative and non-finite values', () => {
    expect(formatSecondsLadder(null)).toBe('—')
    expect(formatSecondsLadder(undefined)).toBe('—')
    expect(formatSecondsLadder(NaN)).toBe('—')
    expect(formatSecondsLadder(Infinity)).toBe('—')
    expect(formatSecondsLadder(-5)).toBe('—')
  })
})

describe('formatMsLadder', () => {
  it('uses ms, tenths of seconds, then the ladder', () => {
    expect(formatMsLadder(850)).toBe('850ms')
    expect(formatMsLadder(4200)).toBe('4.2s')
    expect(formatMsLadder(60_000)).toBe('1m 0s')
    expect(formatMsLadder(125_000)).toBe('2m 5s')
    expect(formatMsLadder(3_780_000)).toBe('1h 3m')
  })
  it('gives a dash for null, NaN and negatives', () => {
    expect(formatMsLadder(null)).toBe('—')
    expect(formatMsLadder(NaN)).toBe('—')
    expect(formatMsLadder(-1)).toBe('—')
  })
})

describe('formatDuration', () => {
  it('measures between two timestamps, or to now', () => {
    expect(formatDuration(ago(59), null)).toBe('59s')
    expect(formatDuration(ago(60), null)).toBe('1m 0s')
    expect(formatDuration(ago(3600), ago(0))).toBe('1h 0m')
    expect(formatDuration(ago(3599), ago(0))).toBe('59m 59s')
  })
  it('gives a dash for a missing start or an end before the start', () => {
    expect(formatDuration(null, null)).toBe('—')
    expect(formatDuration(ago(10), ago(20))).toBe('—')
    expect(formatDuration('garbage', null)).toBe('—')
  })
})

describe('formatRelativeTime', () => {
  it('walks seconds, minutes, hours, days', () => {
    expect(formatRelativeTime(ago(59))).toBe('59s ago')
    expect(formatRelativeTime(ago(60))).toBe('1m ago')
    expect(formatRelativeTime(ago(3599))).toBe('59m ago')
    expect(formatRelativeTime(ago(3600))).toBe('1h ago')
    expect(formatRelativeTime(ago(86400 * 2))).toBe('2d ago')
  })
  it('gives a dash for null', () => {
    expect(formatRelativeTime(null)).toBe('—')
  })
})

describe('formatUptime', () => {
  it('shows hours and minutes, or minutes alone', () => {
    expect(formatUptime(45 * 60)).toBe('45m')
    expect(formatUptime(3599)).toBe('59m')
    expect(formatUptime(3600)).toBe('1h 0m')
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe('3h 12m')
  })
})

describe('timestamps', () => {
  it('formatTimestamp is the local time of day', () => {
    const iso = '2026-06-10T08:30:00Z'
    expect(formatTimestamp(iso)).toBe(new Date(iso).toLocaleTimeString())
  })
  it('formatDateTime is local date and time; garbage passes through', () => {
    const iso = '2026-06-10T08:30:00Z'
    expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString())
    expect(formatDateTime('nope')).toBe('nope')
  })
  it('formatTimestampOrDate adds the date only for events not from today', () => {
    const today = new Date(NOW - 60_000).toISOString()
    const old = new Date(NOW - 3 * 86400_000).toISOString()
    expect(formatTimestampOrDate(today)).toBe(new Date(today).toLocaleTimeString())
    expect(formatTimestampOrDate(old)).toBe(new Date(old).toLocaleString())
    expect(formatTimestampOrDate('nope')).toBe('nope')
  })
  it('treats any time after local midnight as today, and just before it as not', () => {
    const midnight = new Date(NOW)
    midnight.setHours(0, 0, 0, 0)
    const atMidnight = midnight.toISOString()
    const before = new Date(midnight.getTime() - 1000).toISOString()
    expect(formatTimestampOrDate(atMidnight)).toBe(new Date(atMidnight).toLocaleTimeString())
    expect(formatTimestampOrDate(before)).toBe(new Date(before).toLocaleString())
  })
})

describe('until', () => {
  it('formats future times', () => {
    expect(until(ahead(59))).toBe('in 59s')
    expect(until(ahead(60))).toBe('in 1m')
    expect(until(ahead(3599))).toBe('in 59m')
    expect(until(ahead(3600))).toBe('in 1h')
    expect(until(ahead(86400))).toBe('in 1d')
  })
  it('says "due now" for the present and the past, a dash for missing', () => {
    expect(until(ago(0))).toBe('due now')
    expect(until(ago(30))).toBe('due now')
    expect(until(undefined)).toBe('—')
  })
})

describe('formatAge', () => {
  it('formats two largest units', () => {
    expect(formatAge(ago(45))).toBe('45s')
    expect(formatAge(ago(12 * 60))).toBe('12m')
    expect(formatAge(ago(5 * 3600 + 12 * 60))).toBe('5h 12m')
    expect(formatAge(ago(44 * 86400 + 3 * 3600 + 5 * 60))).toBe('44d 3h')
  })
  it('clamps clock skew to 0s', () => { expect(formatAge(ahead(30))).toBe('0s') })
  it('falls back when absent or invalid', () => {
    expect(formatAge(undefined, '1052h34m12s')).toBe('1052h34m12s')
    expect(formatAge('nope', 'x')).toBe('x')
  })
})

describe('formatNumber', () => {
  it('groups digits per locale', () => {
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 }, 'en-US')).toBe('1,234.50')
    expect(formatNumber(1234.5, { minimumFractionDigits: 2 }, 'de-DE')).toBe('1.234,50')
    expect(formatNumber(1234567, undefined, 'en-US')).toBe('1,234,567')
  })
})

describe('formatDay', () => {
  it('formats a Date or day string, short and long', () => {
    expect(formatDay('2026-06-10', 'short', 'en-US')).toBe('Jun 10')
    expect(formatDay(new Date(2026, 5, 10), 'short', 'en-US')).toBe('Jun 10')
    expect(formatDay('2026-06-10', 'long', 'en-US')).toBe('Wednesday, June 10, 2026')
    expect(formatDay('2026-06-10', 'long', 'de-DE')).toBe('Mittwoch, 10. Juni 2026')
  })
  it('returns unparsable input as-is', () => {
    expect(formatDay('nope')).toBe('nope')
  })
})

describe('countLabel', () => {
  it('pluralises', () => {
    expect(countLabel(3, 3, 'triggers')).toBe('3 triggers')
    expect(countLabel(1, 1, 'trigger')).toBe('1 trigger')
    expect(countLabel(1, 1, 'triggers')).toBe('1 trigger')
    expect(countLabel(0, 0, 'triggers')).toBe('0 triggers')
  })
  it('says N of M when a filter hides some', () => {
    expect(countLabel(5, 12, 'missions')).toBe('5 of 12 missions')
    expect(countLabel(0, 1, 'missions')).toBe('0 of 1 mission')
  })
  it('uses an explicit singular', () => {
    expect(countLabel(1, 1, 'entries', 'entry')).toBe('1 entry')
  })
})
