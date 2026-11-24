import { useState, useSyncExternalStore } from 'react'
import {
  START_TAB_OPTIONS,
  getAppPrefs,
  setAppPrefs,
  subscribeAppPrefs,
} from '../../appPrefs'
import { IconNote } from '../../components/Icons'
import ChipRow from '../../components/ChipRow'
import { SettingsExpandableRow, SettingsGroup, SaveStatus } from './SettingsPrimitives'
import { useSettingSave } from './useSettingSave'

export default function GeneralSection() {
  const prefs = useSyncExternalStore(subscribeAppPrefs, getAppPrefs, getAppPrefs)
  const [open, setOpen] = useState(false)
  const save = useSettingSave()

  const current = START_TAB_OPTIONS.find((option) => option.key === prefs.startTab)
  const label = current?.label ?? '笔记'

  return (
    <SettingsGroup id="settings-general" title="通用" hint="启动行为与应用默认设置">
      <SettingsExpandableRow
        icon={<IconNote size={20} />}
        title="启动页"
        subtitle="打开应用时默认进入的页面"
        value={label}
        status={<SaveStatus state={save.state} error={save.error} />}
        open={open}
        onToggle={() => setOpen((value) => !value)}
      >
        <ChipRow
          items={START_TAB_OPTIONS}
          value={prefs.startTab}
          onChange={(startTab) =>
            void save.run(() => {
              setAppPrefs({ startTab })
            })
          }
        />
        <p className="settings-detail-note">
          切换后立即生效，下次启动仍保持该页面。
        </p>
      </SettingsExpandableRow>
    </SettingsGroup>
  )
}
