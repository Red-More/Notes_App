import { describe, expect, it } from 'vitest'
import { DAYS_BACK, DAYS_FORWARD, buildDateOptions, isPickerDate } from './pickerDates'

const TODAY = '2026-11-18'

function shift(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00`)
  d.setDate(d.getDate() + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

describe('isPickerDate', () => {
  it('accepts real calendar days only', () => {
    expect(isPickerDate('2026-11-18')).toBe(true)
    expect(isPickerDate('2028-02-29')).toBe(true)
    expect(isPickerDate('2026-02-31')).toBe(false)
    expect(isPickerDate('2026-13-01')).toBe(false)
    expect(isPickerDate('')).toBe(false)
    expect(isPickerDate('2026-11-18T09:00')).toBe(false)
  })
})

describe('buildDateOptions', () => {
  it('offers the full window around today', () => {
    const { dates, dateIndex } = buildDateOptions(TODAY, TODAY)
    expect(dates).toHaveLength(DAYS_BACK + DAYS_FORWARD + 1)
    expect(dates[0]).toBe(shift(TODAY, -DAYS_BACK))
    expect(dates[dates.length - 1]).toBe(shift(TODAY, DAYS_FORWARD))
    expect(dates[dateIndex]).toBe(TODAY)
  })

  it('selects an in-range initial value', () => {
    const target = shift(TODAY, 12)
    const { dates, dateIndex } = buildDateOptions(TODAY, target)
    expect(dates[dateIndex]).toBe(target)
  })

  it('keeps a far-future initial value so a no-op confirm changes nothing', () => {
    // What a yearly repeat produces: roughly a year ahead, outside the window.
    const target = shift(TODAY, 365)
    const { dates, dateIndex } = buildDateOptions(TODAY, target)
    expect(dates[dateIndex]).toBe(target)
    expect(dates).toContain(target)
  })

  it('keeps a far-past initial value', () => {
    const target = shift(TODAY, -365)
    const { dates, dateIndex } = buildDateOptions(TODAY, target)
    expect(dates[dateIndex]).toBe(target)
  })

  it('stays sorted and duplicate-free when the value is injected', () => {
    const { dates } = buildDateOptions(TODAY, shift(TODAY, 365))
    expect([...dates].sort()).toEqual(dates)
    expect(new Set(dates).size).toBe(dates.length)
  })

  it('falls back to today for an unusable initial value', () => {
    for (const initial of ['', '2026-13-45', 'not-a-date']) {
      const { dates, dateIndex } = buildDateOptions(TODAY, initial)
      expect(dates[dateIndex]).toBe(TODAY)
      expect(dates).toHaveLength(DAYS_BACK + DAYS_FORWARD + 1)
    }
  })
})
