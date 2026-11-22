import { useState, useSyncExternalStore } from 'react'
import {
  FONT_FINE_RANGE,
  FONT_SCALE_OPTIONS,
  getAppPrefs,
  setAppPrefs,
  subscribeAppPrefs,
  type AppPrefs,
} from '../../appPrefs'
import { IconEye, IconInfo, IconNote } from '../../components/Icons'
import { getStoredTheme, setStoredTheme, type Theme } from '../../theme'
import ChipRow from '../../components/ChipRow'
import { SettingsExpandableRow, SettingsGroup, SettingsRow, SaveStatus } from './SettingsPrimitives'
import { useSettingSave } from './useSettingSave'

const THEME_OPTIONS: Array<{ key: Theme; label: string }> = [
  { key: 'system', label: '跟随系统' },
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
]

const themeLabel = (theme: Theme) =>
  THEME_OPTIONS.find((option) => option.key === theme)?.label ?? '跟随系统'

const fontLabel = (scale: AppPrefs['fontScale']) =>
  FONT_SCALE_OPTIONS.find((option) => option.key === scale)?.label ?? 'M'

const fineLabel = (fine: number) => `${fine > 0 ? '+' : ''}${fine}%`

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

  const chooseFont = (patch: Partial<Pick<AppPrefs, 'fontScale' | 'fontFine'>>) => {
    void fontSave.run(() => {
      setAppPrefs(patch)
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
        subtitle="档位切换 + 微调，拖动即时预览"
        value={`${fontLabel(prefs.fontScale)} · ${fineLabel(prefs.fontFine)}`}
        status={<SaveStatus state={fontSave.state} error={fontSave.error} />}
        open={fontOpen}
        onToggle={() => setFontOpen((open) => !open)}
      >
        <p className="font-scale-sample">字号预览：笔记正文会按这个大小与行距显示。</p>
        <div className="settings-detail-field">
          <span className="settings-detail-label">档位</span>
          <ChipRow
            items={FONT_SCALE_OPTIONS}
            value={prefs.fontScale}
            onChange={(fontScale) => chooseFont({ fontScale })}
          />
        </div>
        <div className="settings-detail-field">
          <span className="settings-detail-label">微调（{fineLabel(prefs.fontFine)}）</span>
          <input
            type="range"
            className="font-fine-slider"
            min={-FONT_FINE_RANGE}
            max={FONT_FINE_RANGE}
            step={1}
            value={prefs.fontFine}
            onChange={(e) => chooseFont({ fontFine: Number(e.target.value) })}
            aria-label="字号微调"
            aria-valuetext={fineLabel(prefs.fontFine)}
          />
        </div>
        <p className="settings-detail-note">
          档位之间差异明显，微调在档位附近细修 ±{FONT_FINE_RANGE}%；正文、预览与界面文字同步生效。
        </p>
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
