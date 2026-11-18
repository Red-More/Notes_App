import type { RepeatValue } from './todoFile'

export type { RepeatValue }

/**
 * Supported repeat intervals; persisted on the todo frontmatter.
 *
 * Typed against [`RepeatValue`] so this list and the file format can never
 * drift apart.
 */
export const REPEAT_OPTIONS: ReadonlyArray<{ value: RepeatValue; label: string }> = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekday', label: '周一至周五' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
]

const pad = (n: number) => String(n).padStart(2, '0')

/** Days in `month` (0-based) of `year`; day 0 of the next month is the last day. */
function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/**
 * Advance a local "YYYY-MM-DDTHH:mm" time by one repeat interval.
 *
 * `monthly` and `yearly` clamp to the last day of the target month instead of
 * letting `Date` overflow into the following one: a reminder on the 31st must
 * become the 30th (or 28th/29th) rather than skipping a month entirely, and
 * Feb 29 must become Feb 28 in a common year rather than Mar 1.
 *
 * Returns `null` when the repeat is not an advancing interval (including
 * `none`) or when the input cannot be parsed.
 */
export function nextDue(due: string, repeat: string): string | null {
  const d = new Date(due.replace(' ', 'T'))
  if (Number.isNaN(d.getTime())) return null

  switch (repeat) {
    case 'daily':
      d.setDate(d.getDate() + 1)
      break
    case 'weekday': {
      // Saturday/Sunday roll to the following Monday.
      do {
        d.setDate(d.getDate() + 1)
      } while (d.getDay() === 0 || d.getDay() === 6)
      break
    }
    case 'weekly':
      d.setDate(d.getDate() + 7)
      break
    case 'monthly': {
      const day = d.getDate()
      // Move to the 1st before switching month: `setMonth` keeps the day, so
      // calling it on the 31st would overflow into the month after next.
      d.setDate(1)
      d.setMonth(d.getMonth() + 1)
      d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())))
      break
    }
    case 'yearly': {
      const month = d.getMonth()
      const day = d.getDate()
      d.setDate(1)
      d.setFullYear(d.getFullYear() + 1)
      d.setMonth(month)
      d.setDate(Math.min(day, daysInMonth(d.getFullYear(), month)))
      break
    }
    default:
      return null
  }

  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
