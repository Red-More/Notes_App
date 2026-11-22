import { useEffect, useState, useSyncExternalStore } from 'react'
import { getAppPrefs, setAppPrefs, subscribeAppPrefs } from '../../appPrefs'
import { IconBell, IconCalendar, IconVolume } from '../../components/Icons'
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from '../../notifications'
import { reminderSoundLabel, type ReminderSoundId } from '../../reminders/ringtones'
import {
  SettingsExpandableRow,
  SettingsGroup,
  SettingsRow,
  SettingsSwitchRow,
  SaveStatus,
} from './SettingsPrimitives'
import ReminderSoundPicker from './ReminderSoundPicker'
import { useSettingSave } from './useSettingSave'

const PERMISSION_LABEL: Record<NotificationPermission | 'checking', string> = {
  checking: '检测中…',
  granted: '已授权',
  denied: '未授权',
  unavailable: '不可用',
}

export default function NotificationSection() {
  const prefs = useSyncExternalStore(subscribeAppPrefs, getAppPrefs, getAppPrefs)
  const [permission, setPermission] = useState<NotificationPermission | 'checking'>('checking')
  const [soundOpen, setSoundOpen] = useState(false)
  const toggleSave = useSettingSave()
  const missedSave = useSettingSave()
  const requestSave = useSettingSave()
  const soundSave = useSettingSave()
  const forceSave = useSettingSave()

  useEffect(() => {
    let cancelled = false
    void notificationPermission().then((value) => {
      if (!cancelled) setPermission(value)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const authorize = () => {
    void requestSave.run(async () => {
      const granted = await requestNotificationPermission()
      setPermission(granted ? 'granted' : 'denied')
      if (!granted) throw new Error('未获得通知权限')
    })
  }

  const chooseSound = (next: ReminderSoundId) => {
    void soundSave.run(() => {
      setAppPrefs({ reminderSound: next })
    })
  }

  const canRequest = permission === 'denied'

  return (
    <SettingsGroup
      id="settings-notifications"
      title="通知"
      hint="提醒仅在应用运行时送达；强制提醒会用应用内铃声持续响铃"
    >
      <SettingsSwitchRow
        icon={<IconBell size={20} />}
        title="提醒通知"
        subtitle="待办到期时提醒"
        checked={prefs.remindersEnabled}
        onChange={(next) =>
          void toggleSave.run(() => {
            setAppPrefs({ remindersEnabled: next })
          })
        }
        status={<SaveStatus state={toggleSave.state} error={toggleSave.error} />}
      />
      <SettingsExpandableRow
        icon={<IconBell size={20} />}
        title="提醒铃声"
        subtitle="待办到期时播放的提示音"
        value={reminderSoundLabel(prefs.reminderSound)}
        status={<SaveStatus state={soundSave.state} error={soundSave.error} />}
        open={soundOpen}
        onToggle={() => setSoundOpen((open) => !open)}
      >
        <ReminderSoundPicker value={prefs.reminderSound} onChange={chooseSound} />
        <p className="settings-detail-note">
          铃声由应用内播放；系统通知提示音由系统控制，移动端免打扰仍可能拦截系统通知。
        </p>
      </SettingsExpandableRow>
      <SettingsSwitchRow
        icon={<IconVolume size={20} />}
        title="强制提醒"
        subtitle={
          prefs.remindersEnabled
            ? '静音、免打扰或专注模式下持续响铃，直到手动关闭'
            : '开启「提醒通知」后可用'
        }
        checked={prefs.forceReminder}
        disabled={!prefs.remindersEnabled}
        onChange={(next) =>
          void forceSave.run(() => {
            setAppPrefs({ forceReminder: next })
          })
        }
        status={<SaveStatus state={forceSave.state} error={forceSave.error} />}
      />
      <SettingsSwitchRow
        icon={<IconCalendar size={20} />}
        title="未写日记提醒"
        subtitle="在日历上标出没有日记的日子"
        checked={prefs.markMissedDiary}
        onChange={(next) =>
          void missedSave.run(() => {
            setAppPrefs({ markMissedDiary: next })
          })
        }
        status={<SaveStatus state={missedSave.state} error={missedSave.error} />}
      />
      <SettingsRow
        icon={<IconBell size={20} />}
        title="系统通知权限"
        subtitle={
          permission === 'granted'
            ? '系统通知可正常送达'
            : permission === 'unavailable'
              ? '当前运行环境不支持系统通知'
              : '未授权时提醒会退回应用内提示'
        }
        value={PERMISSION_LABEL[permission]}
        status={<SaveStatus state={requestSave.state} error={requestSave.error} />}
        chevron={canRequest}
        onClick={canRequest ? authorize : undefined}
        ariaLabel="设置系统通知权限"
      />
    </SettingsGroup>
  )
}
