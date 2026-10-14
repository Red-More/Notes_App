import { useEffect } from 'react'
import { api } from '../api'
import { toast } from '../toast'
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { dateStr, monthStr, parseDbTime } from '../utils'

const CHECK_INTERVAL_MS = 30_000
const TODO_WINDOW_MS = 30 * 60_000
const SCHEDULE_EARLY_MS = 5 * 60_000
const SCHEDULE_LATE_MS = 15 * 60_000
const REMINDED_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const notified = (key: string) => localStorage.getItem(`reminded:${key}`) === '1'
const markNotified = (key: string) => localStorage.setItem(`reminded:${key}`, '1')

// Memoize the notification permission so it is only requested once per app run.
let permissionPromise: Promise<boolean> | null = null

function ensurePermission(): Promise<boolean> {
  if (!permissionPromise) {
    permissionPromise = (async () => {
      if (await isPermissionGranted()) return true
      return (await requestPermission()) === 'granted'
    })()
  }
  return permissionPromise
}

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
  if (await ensurePermission()) {
    sendNotification({ title: 'Notes 提醒', body: text })
  } else {
    toast(text)
  }
}

async function checkReminders() {
  const now = Date.now()
  try {
    // Remind on todos whose due time has just passed (within 30 min window).
    const todos = await api.listTodos()
    for (const t of todos) {
      if (t.reminder !== 1 || t.isCompleted === 1 || !t.dueDate) continue
      const due = parseDbTime(t.dueDate).getTime()
      const age = now - due
      if (age >= 0 && age < TODO_WINDOW_MS) {
        const key = `todo:${t.id}:${due}`
        if (!notified(key)) {
          markNotified(key)
          await notify(`⏰ 待办提醒：${t.title}`)
        }
      }
    }

    // Remind on today's schedules from 5 min before start until 15 min after.
    const today = dateStr(new Date())
    const schedules = await api.listSchedules(monthStr(new Date()))
    for (const s of schedules) {
      if (s.reminder !== 1 || s.date !== today || !s.startTime) continue
      const start = parseDbTime(`${s.date}T${s.startTime}`).getTime()
      const delta = now - start
      if (delta >= -SCHEDULE_EARLY_MS && delta < SCHEDULE_LATE_MS) {
        const key = `schedule:${s.id}:${start}`
        if (!notified(key)) {
          markNotified(key)
          await notify(`⏰ 日程提醒：${s.title}`)
        }
      }
    }
  } catch {
    // Backend not reachable (e.g. during dev hot reload); skip this cycle.
  }
}

/**
 * In-app reminder: while the app is running, periodically checks
 * todos / schedules with reminders enabled and notifies when due.
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
