import { describe, expect, it } from 'vitest'
import { nextDue, REPEAT_OPTIONS } from './repeat'

describe('nextDue', () => {
  it('advances the simple intervals and keeps the time of day', () => {
    expect(nextDue('2026-11-18T09:30', 'daily')).toBe('2026-11-19T09:30')
    expect(nextDue('2026-11-18T09:30', 'weekly')).toBe('2026-11-25T09:30')
  })

  it('rolls weekends to Monday for the weekday interval', () => {
    // 2026-11-20 is a Friday: the next weekday is Monday the 23rd.
    expect(nextDue('2026-11-20T08:00', 'weekday')).toBe('2026-11-23T08:00')
    // 2026-11-21 is a Saturday: same target.
    expect(nextDue('2026-11-21T08:00', 'weekday')).toBe('2026-11-23T08:00')
    // A Monday advances by one day, not a week.
    expect(nextDue('2026-11-23T08:00', 'weekday')).toBe('2026-11-24T08:00')
  })

  it('clamps a monthly repeat to the last day instead of skipping a month', () => {
    // The bug this replaced: Jan 31 + setMonth(1) overflowed to Mar 3.
    expect(nextDue('2026-01-31T10:00', 'monthly')).toBe('2026-02-28T10:00')
    // 2028 is a leap year, so February has 29 days.
    expect(nextDue('2028-01-31T10:00', 'monthly')).toBe('2028-02-29T10:00')
    // A day that exists in the target month is preserved exactly.
    expect(nextDue('2026-01-15T10:00', 'monthly')).toBe('2026-02-15T10:00')
    // 31 -> 30 for a 30-day month.
    expect(nextDue('2026-03-31T10:00', 'monthly')).toBe('2026-04-30T10:00')
    // December must roll into the next year.
    expect(nextDue('2026-12-31T10:00', 'monthly')).toBe('2027-01-31T10:00')
  })

  it('clamps Feb 29 on a yearly repeat to Feb 28 in a common year', () => {
    // The bug this replaced: 2028-02-29 + setFullYear overflowed to 2029-03-01.
    expect(nextDue('2028-02-29T07:00', 'yearly')).toBe('2029-02-28T07:00')
    // The clamp sticks on later years instead of drifting further.
    expect(nextDue('2029-02-28T07:00', 'yearly')).toBe('2030-02-28T07:00')
    // An ordinary date is untouched, including one in a leap year.
    expect(nextDue('2026-06-15T12:00', 'yearly')).toBe('2027-06-15T12:00')
    expect(nextDue('2027-06-15T12:00', 'yearly')).toBe('2028-06-15T12:00')
  })

  it('advances across month and year boundaries for daily repeats', () => {
    expect(nextDue('2026-12-31T23:59', 'daily')).toBe('2027-01-01T23:59')
    expect(nextDue('2028-02-28T06:00', 'daily')).toBe('2028-02-29T06:00')
  })

  it('returns null for non-advancing or unknown repeats', () => {
    expect(nextDue('2026-11-18T09:30', 'none')).toBeNull()
    expect(nextDue('2026-11-18T09:30', '')).toBeNull()
    expect(nextDue('2026-11-18T09:30', 'fortnightly')).toBeNull()
  })

  it('returns null for an unparseable input rather than an invalid date', () => {
    expect(nextDue('not-a-date', 'daily')).toBeNull()
    expect(nextDue('', 'daily')).toBeNull()
  })

  it('rejects every stored repeat except none', () => {
    // Guards the option list against a value the scheduler cannot advance.
    const advancing = REPEAT_OPTIONS.filter((o) => o.value !== 'none')
    for (const option of advancing) {
      expect(nextDue('2026-11-18T09:30', option.value)).not.toBeNull()
    }
    expect(nextDue('2026-11-18T09:30', 'none')).toBeNull()
  })
})
