import { useEffect } from 'react'
import { api } from '../api'
import { toast } from './ui'
import { dateStr, monthStr, parseDbTime } from '../utils'

const CHECK_INTERVAL_MS = 30_000
const TODO_WINDOW_MS = 30 * 60_000
const SCHEDULE_EARLY_MS = 5 * 60_000
const SCHEDULE_LATE_MS = 15 * 60_000

const notified = (key: string) => localStorage.getItem(`reminded:${key}`) === '1'
const markNotified = (key: string) => localStorage.setItem(`reminded:${key}`, '1')

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
          toast(`⏰ 待办提醒：${t.title}`)
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
          toast(`⏰ 日程提醒：${s.title}`)
        }
      }
    }
  } catch {
    // Backend not reachable (e.g. during dev hot reload); skip this cycle.
  }
}

/**
 * In-app reminder: while the app is running, periodically checks
 * todos / schedules with reminders enabled and toasts when due.
 */
export default function ReminderScheduler() {
  useEffect(() => {
    void checkReminders()
    const timer = setInterval(() => void checkReminders(), CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])
  return null
}
