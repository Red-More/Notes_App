import { useEffect, useState, useSyncExternalStore } from 'react'
import { getAppPrefs, setAppPrefs, subscribeAppPrefs } from '../../appPrefs'
import { IconBell } from '../../components/Icons'
import {
  notificationPermission,
  requestNotificationPermission,
  type NotificationPermission,
} from '../../notifications'
import { SettingsGroup, SettingsRow, SettingsSwitchRow, SaveStatus } from './SettingsPrimitives'
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
  const toggleSave = useSettingSave()
  const requestSave = useSettingSave()

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

  const canRequest = permission === 'denied'

  return (
    <SettingsGroup
      id="settings-notifications"
      title="通知"
      hint="提醒仅在应用运行时由系统通知送达"
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
