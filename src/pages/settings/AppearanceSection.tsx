import { useState, useSyncExternalStore } from 'react'
import {
  FONT_SCALE_OPTIONS,
  getAppPrefs,
  setAppPrefs,
  subscribeAppPrefs,
  type AppPrefs,
} from '../../appPrefs'
import { IconEye, IconInfo, IconNote } from '../../components/Icons'
import { getStoredTheme, setStoredTheme, type Theme } from '../../theme'
import ChipRow from '../../components/ChipRow'
import {
  SettingsExpandableRow,
  SettingsGroup,
  SettingsRow,
  SaveStatus,
} from './SettingsPrimitives'
import { useSettingSave } from './useSettingSave'

const THEME_OPTIONS: Array<{ key: Theme; label: string }> = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
]

const themeLabel = (theme: Theme) =>
  THEME_OPTIONS.find((option) => option.key === theme)?.label ?? '跟随系统'

const fontLabel = (scale: AppPrefs['fontScale']) =>
  FONT_SCALE_OPTIONS.find((option) => option.key === scale)?.label ?? '标准'

export default function AppearanceSection() {
  const prefs = useSyncExternalStore(subscribeAppPrefs, getAppPrefs, getAppPrefs)
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme())
  const [themeOpen, setThemeOpen] = useState(false)
  const [fontOpen, setFontOpen] = useState(false)
  const themeSave = useSettingSave()
  const fontSave = useSettingSave()

  const chooseTheme = (next: Theme) => {
    setTheme(next)
    void themeSave.run(() => setStoredTheme(next))
  }

  const chooseFont = (next: AppPrefs['fontScale']) => {
    void fontSave.run(() => {
      setAppPrefs({ fontScale: next })
    })
  }

  return (
    <SettingsGroup id="settings-appearance" title="外观与语言">
      <SettingsExpandableRow
        icon={<IconEye size={20} />}
        title="深色模式"
        subtitle="跟随系统或固定主题"
        value={themeLabel(theme)}
        status={<SaveStatus state={themeSave.state} error={themeSave.error} />}
        open={themeOpen}
        onToggle={() => setThemeOpen((open) => !open)}
      >
        <ChipRow items={THEME_OPTIONS} value={theme} onChange={chooseTheme} />
      </SettingsExpandableRow>

      <SettingsExpandableRow
        icon={<IconNote size={20} />}
        title="字体大小"
        subtitle="即时预览，随系统字体缩放"
        value={fontLabel(prefs.fontScale)}
        status={<SaveStatus state={fontSave.state} error={fontSave.error} />}
        open={fontOpen}
        onToggle={() => setFontOpen((open) => !open)}
      >
        <ChipRow items={FONT_SCALE_OPTIONS} value={prefs.fontScale} onChange={chooseFont} />
      </SettingsExpandableRow>

      <SettingsRow
        icon={<IconInfo size={20} />}
        title="语言"
        subtitle="更多语言将在后续版本提供"
        value="简体中文"
      />
    </SettingsGroup>
  )
}
