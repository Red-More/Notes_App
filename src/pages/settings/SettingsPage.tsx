import { useState } from 'react'
import { getStoredTheme, setStoredTheme, type Theme } from '../../theme'
import { IconBack } from '../../components/Icons'
import ChipRow from '../../components/ChipRow'

interface Props {
  onBack: () => void
}

const THEME_OPTIONS: Array<{ key: Theme; label: string }> = [
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
  { key: 'system', label: '跟随系统' },
]

export default function SettingsPage({ onBack }: Props) {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme())

  const handleTheme = (t: Theme) => {
    setTheme(t)
    setStoredTheme(t)
  }

  return (
    <div className="editor-page">
      <div className="editor-topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          <IconBack size={22} />
        </button>
        <span className="modal-title" style={{ marginLeft: 6 }}>
          设置
        </span>
      </div>

      <div className="page-scroll" style={{ paddingTop: 16 }}>
        <div className="form-field">
          <span className="form-label">主题</span>
          <ChipRow items={THEME_OPTIONS} value={theme} onChange={handleTheme} />
        </div>
      </div>
    </div>
  )
}
