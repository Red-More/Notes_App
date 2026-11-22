//! Pure reminder rules shared by the scheduler and its tests.
//!
//! Keeping the due-window check and the sound decision here makes every
//! combination (master switch × force switch) explicit and testable without a
//! running WebView.

import type { AppPrefs } from '../appPrefs'

/** Reminders fire when the due time is at most this far in the past. */
export const REMINDER_WINDOW_MS = 30 * 60_000

/** `silent` skips ringing; `once` plays a single cycle; `force` loops it. */
export type ReminderRingMode = 'silent' | 'once' | 'force'

export function isReminderDue(remindAt: number, now: number): boolean {
  const age = now - remindAt
  return age >= 0 && age < REMINDER_WINDOW_MS
}

/**
 * Master alert switch first: when reminders are off nothing rings, even with
 * the force switch on. The force switch only controls how a due reminder rings.
 */
export function reminderRingMode(
  prefs: Pick<AppPrefs, 'remindersEnabled' | 'forceReminder'>,
): ReminderRingMode {
  if (!prefs.remindersEnabled) return 'silent'
  return prefs.forceReminder ? 'force' : 'once'
}
