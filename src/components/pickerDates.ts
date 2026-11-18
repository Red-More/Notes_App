import { dateStr } from '../utils'

/** How many days back / forward the date column offers by default. */
export const DAYS_BACK = 7
export const DAYS_FORWARD = 90

/** `YYYY-MM-DD`, and a real calendar day (rejects 2026-02-31). */
export function isPickerDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00`)
  return !Number.isNaN(d.getTime()) && dateStr(d) === value
}

/**
 * Date-wheel options around `today`.
 *
 * The existing value is always present, even when it falls outside the
 * `DAYS_BACK..DAYS_FORWARD` window: confirming the picker without scrolling must
 * be a no-op, so a far-future reminder (e.g. one a `yearly` repeat rolled
 * forward) is never silently rewritten to today. An unusable `initial` seeds
 * today instead.
 */
export function buildDateOptions(
  today: string,
  initial: string,
): { dates: string[]; dateIndex: number } {
  const base = new Date(`${isPickerDate(today) ? today : dateStr(new Date())}T00:00:00`)
  const dates: string[] = []
  for (let offset = -DAYS_BACK; offset <= DAYS_FORWARD; offset += 1) {
    const d = new Date(base)
    d.setDate(d.getDate() + offset)
    dates.push(dateStr(d))
  }
  const seed = isPickerDate(initial) ? initial : dateStr(base)
  if (!dates.includes(seed)) {
    // Lexicographic order equals chronological order for `YYYY-MM-DD`.
    dates.push(seed)
    dates.sort()
  }
  return { dates, dateIndex: dates.indexOf(seed) }
}
