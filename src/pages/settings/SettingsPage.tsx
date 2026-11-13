import { IconBack } from '../../components/Icons'
import { useEdgeBack } from '../../hooks'
import { usePhysicalBack } from '../../system/backButton'
import AccountSection from './AccountSection'
import AiSection from './AiSection'
import AppearanceSection from './AppearanceSection'
import AboutSection from './AboutSection'
import EditorSection from './EditorSection'
import NotificationSection from './NotificationSection'
import StorageSection from './StorageSection'

interface Props {
  onBack: () => void
}

const QUICK_NAV = [
  { id: 'settings-account', label: '账号' },
  { id: 'settings-notifications', label: '通知' },
  { id: 'settings-appearance', label: '外观' },
  { id: 'settings-editor', label: '编辑' },
  { id: 'settings-ai', label: 'AI' },
  { id: 'settings-storage', label: '存储' },
  { id: 'settings-about', label: '关于' },
]

export default function SettingsPage({ onBack }: Props) {
  // Same pop semantics for the edge swipe and the Android back key: return to
  // the tab that opened settings instead of jumping to a home tab.
  useEdgeBack(onBack)
  usePhysicalBack(onBack)

  const jumpTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="editor-page settings-page">
      <header className="settings-topbar">
        <button type="button" className="settings-back" onClick={onBack} aria-label="返回">
          <IconBack size={22} />
        </button>
        <div className="settings-title-block">
          <h1 className="settings-title">设置</h1>
          <span className="settings-subtitle">更改自动保存</span>
        </div>
      </header>

      <main className="settings-scroll">
        <nav className="settings-quicknav" aria-label="设置分组">
          {QUICK_NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className="settings-quicknav-chip"
              onClick={() => jumpTo(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <AccountSection />
        <NotificationSection />
        <AppearanceSection />
        <EditorSection />
        <AiSection />
        <StorageSection />
        <AboutSection />

        <footer className="settings-footer">
          <span>Notes</span>
          <span>本地优先 · 数据仅存本机</span>
        </footer>
      </main>
    </div>
  )
}
