import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../api'
import { getAppPrefs, subscribeAppPrefs } from '../appPrefs'
import { ensureNotificationPermission } from '../notifications'
import { toast } from '../toast'
import { sendNotification } from '@tauri-apps/plugin-notification'
import { parseDbTime } from '../utils'
import { nextDue } from '../todos/repeat'
import { IconBell } from './Icons'
import { OverlayPortal } from './ui'
import {
  playReminderSoundOnce,
  startForcedReminderSound,
  type RingtonePlayback,
} from '../reminders/ringtonePlayer'
import { isReminderDue, reminderRingMode, type ReminderRingMode } from '../reminders/reminderLogic'

const CHECK_INTERVAL_MS = 30_000
const REMINDED_KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
/** Safety cap so a forgotten alarm cannot ring forever. */
const FORCE_RING_MAX_MS = 2 * 60_000

type RingMode = Exclude<ReminderRingMode, 'silent'>

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
    try {
      sendNotification({ title: 'Notes 提醒', body: text })
      return
    } catch {
      // Permission can be revoked between the check and the send.
    }
  }
  toast(text)
}

async function checkReminders(onDue: (titles: string[], mode: RingMode) => void) {
  // Master switch in Settings; read every cycle so toggling takes effect at once.
  const mode = reminderRingMode(getAppPrefs())
  if (mode === 'silent') return
  const now = Date.now()
  try {
    // Remind on todos whose due time has just passed (within 30 min window).
    // `migrate: false`: a periodic timer must never trigger the one-time
    // legacy rewrite; the Todo page owns that trigger.
    const todos = await api.listTodos(undefined, { migrate: false })
    const fired: string[] = []
    for (const t of todos) {
      // Only the reminder notifies. The deadline is a separate value and never
      // reaches this loop, so a due date alone cannot produce a notification.
      if (t.isCompleted === 1 || !t.remindAt) continue
      const at = parseDbTime(t.remindAt).getTime()
      if (!isReminderDue(at, now)) continue
      const key = `todo:${t.id}:${at}`
      if (notified(key)) continue
      markNotified(key)
      fired.push(t.title)
      await notify(`⏰ 待办提醒：${t.title}`)
      // Repeating todos roll forward to the next occurrence after firing.
      if (t.repeat && t.repeat !== 'none') {
        const next = nextDue(t.remindAt, t.repeat)
        if (next) {
          await api.updateTodo(t, { title: t.title, remindAt: next, repeat: t.repeat })
        }
      }
    }
    if (fired.length > 0) onDue(fired, mode)
  } catch {
    // Backend not reachable (e.g. during dev hot reload); skip this cycle.
  }
}

interface AlarmState {
  title: string
  count: number
}

/**
 * In-app reminder: while the app is running, periodically checks todos with
 * reminders enabled and rings the selected tone. With "强制提醒" on, the tone
 * loops behind a dismissible banner instead of playing a single cycle.
 */
export default function ReminderScheduler() {
  const prefs = useSyncExternalStore(subscribeAppPrefs, getAppPrefs, getAppPrefs)
  const [alarm, setAlarm] = useState<AlarmState | null>(null)
  const [ringing, setRinging] = useState(false)
  const playback = useRef<RingtonePlayback | null>(null)
  const ringTimer = useRef<number | undefined>(undefined)
  // Guards the async start: a dismiss while `resume()` is pending wins.
  const requestId = useRef(0)

  const haltSound = useCallback(() => {
    playback.current?.stop()
    playback.current = null
    window.clearTimeout(ringTimer.current)
    ringTimer.current = undefined
    setRinging(false)
  }, [])

  const handleDue = useCallback(
    async (titles: string[], mode: RingMode) => {
      const sound = getAppPrefs().reminderSound
      if (mode === 'once') {
        void playReminderSoundOnce(sound)
        return
      }
      const id = ++requestId.current
      haltSound()
      setAlarm({ title: titles[0] ?? '待办提醒', count: titles.length })
      const started = await startForcedReminderSound(sound)
      if (id !== requestId.current) {
        started?.stop()
        return
      }
      if (!started) {
        toast('当前环境无法播放提醒铃声，请检查系统音量')
        return
      }
      playback.current = started
      setRinging(true)
      ringTimer.current = window.setTimeout(() => {
        started.stop()
        playback.current = null
        setRinging(false)
      }, FORCE_RING_MAX_MS)
    },
    [haltSound],
  )

  const dismissAlarm = useCallback(() => {
    requestId.current += 1
    haltSound()
    setAlarm(null)
  }, [haltSound])

  useEffect(() => {
    cleanupRemindedKeys()
    void checkReminders(handleDue)
    const timer = window.setInterval(() => void checkReminders(handleDue), CHECK_INTERVAL_MS)
    return () => {
      window.clearInterval(timer)
      requestId.current += 1
      haltSound()
    }
  }, [handleDue, haltSound])

  // Turning either switch off silences an alarm that is already ringing.
  useEffect(() => {
    if (prefs.remindersEnabled && prefs.forceReminder) return
    requestId.current += 1
    haltSound()
    setAlarm(null)
  }, [prefs.remindersEnabled, prefs.forceReminder, haltSound])

  if (!alarm) return null
  const text = alarm.count > 1 ? `${alarm.title} 等 ${alarm.count} 项待办已到期` : alarm.title
  return (
    <OverlayPortal>
      <div className="reminder-alarm" role="alert" aria-live="assertive">
        <span className="reminder-alarm-icon" aria-hidden="true">
          <IconBell size={22} />
        </span>
        <span className="reminder-alarm-body">
          <span className="reminder-alarm-title">{ringing ? '强制提醒' : '待办提醒'}</span>
          <span className="reminder-alarm-text">{text}</span>
        </span>
        <button type="button" className="reminder-alarm-stop" onClick={dismissAlarm}>
          {ringing ? '停止铃声' : '知道了'}
        </button>
      </div>
    </OverlayPortal>
  )
}
