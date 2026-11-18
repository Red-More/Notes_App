import { useEffect } from 'react'
import { api } from '../api'
import { getAppPrefs } from '../appPrefs'
import { ensureNotificationPermission } from '../notifications'
import { toast } from '../toast'
import { sendNotification } from '@tauri-apps/plugin-notification'
import { parseDbTime } from '../utils'
import { nextDue } from '../todos/repeat'

const CHECK_INTERVAL_MS = 30_000
const TODO_WINDOW_MS = 30 * 60_000
const REMINDED_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const notified = (key: string) => localStorage.getItem(`reminded:${key}`) === '1'
const markNotified = (key: string) => localStorage.setItem(`reminded:${key}`, '1')

/** Remove reminded dedupe keys older than 7 days, plus any malformed ones. */
function cleanupRemindedKeys() {
  const expired: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith('reminded:')) continue
    const ts = Number(key.slice(key.lastIndexOf(':') + 1))
    if (Number.isNaN(ts) || Date.now() - ts > REMINDED_KEY_TTL_MS) expired.push(key)
  }
  for (const key of expired) localStorage.removeItem(key)
}

/** Send a system notification when permitted, otherwise fall back to the in-app toast. */
async function notify(text: string) {
  if (await ensureNotificationPermission()) {
    sendNotification({ title: 'Notes 提醒', body: text })
  } else {
    toast(text)
  }
}

async function checkReminders() {
  // Master switch in Settings; read every cycle so toggling takes effect at once.
  if (!getAppPrefs().remindersEnabled) return
  const now = Date.now()
  try {
    // Remind on todos whose due time has just passed (within 30 min window).
    // `migrate: false`: a periodic timer must never trigger the one-time
    // legacy rewrite; the Todo page owns that trigger.
    const todos = await api.listTodos(undefined, { migrate: false })
    for (const t of todos) {
      // Only the reminder notifies. The deadline is a separate value and never
      // reaches this loop, so a due date alone cannot produce a notification.
      if (t.isCompleted === 1 || !t.remindAt) continue
      const at = parseDbTime(t.remindAt).getTime()
      const age = now - at
      if (age >= 0 && age < TODO_WINDOW_MS) {
        const key = `todo:${t.id}:${at}`
        if (!notified(key)) {
          markNotified(key)
          await notify(`⏰ 待办提醒：${t.title}`)
          // Repeating todos roll forward to the next occurrence after firing.
          if (t.repeat && t.repeat !== 'none') {
            const next = nextDue(t.remindAt, t.repeat)
            if (next) {
              await api.updateTodo(t, { title: t.title, remindAt: next, repeat: t.repeat })
            }
          }
        }
      }
    }
  } catch {
    // Backend not reachable (e.g. during dev hot reload); skip this cycle.
  }
}

/**
 * In-app reminder: while the app is running, periodically checks todos with
 * reminders enabled and notifies when due.
 */
export default function ReminderScheduler() {
  useEffect(() => {
    cleanupRemindedKeys()
    void checkReminders()
    const timer = setInterval(() => void checkReminders(), CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])
  return null
}
