import { describe, expect, it } from 'vitest'
import { REMINDER_WINDOW_MS, isReminderDue, reminderRingMode } from './reminderLogic'

describe('isReminderDue', () => {
  const now = 1_700_000_000_000

  it('fires only inside the window that starts at the reminder time', () => {
    expect(isReminderDue(now + 1_000, now)).toBe(false)
    expect(isReminderDue(now, now)).toBe(true)
    expect(isReminderDue(now - REMINDER_WINDOW_MS + 1, now)).toBe(true)
    expect(isReminderDue(now - REMINDER_WINDOW_MS, now)).toBe(false)
    expect(isReminderDue(now - REMINDER_WINDOW_MS - 1, now)).toBe(false)
  })
})

describe('reminderRingMode', () => {
  it('stays silent whenever the master reminder switch is off', () => {
    expect(reminderRingMode({ remindersEnabled: false, forceReminder: false })).toBe('silent')
    expect(reminderRingMode({ remindersEnabled: false, forceReminder: true })).toBe('silent')
  })

  it('rings once normally and loops only when forcing', () => {
    expect(reminderRingMode({ remindersEnabled: true, forceReminder: false })).toBe('once')
    expect(reminderRingMode({ remindersEnabled: true, forceReminder: true })).toBe('force')
  })
})
