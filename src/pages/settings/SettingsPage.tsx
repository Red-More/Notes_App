import { useSyncExternalStore, useState } from 'react'
import { getStoredTheme, setStoredTheme, type Theme } from '../../theme'
import {
  DEFAULT_INTERVAL,
  DEFAULT_STRATEGY,
  SAVE_INTERVALS,
  SAVE_STRATEGIES,
  getSaveStrategy,
  setSaveStrategy,
  type SaveStrategyKey,
  type SaveStrategyMeta,
} from '../../saveStrategy'
import {
  INDENT_SIZES,
  getEditorPrefs,
  setEditorPrefs,
  type IndentStyle,
} from '../../editor/prefs'
import {
  DEFAULT_LAYOUT_PREFS,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  clearLayoutPrefs,
  getLayoutPrefs,
  layoutModeOf,
  setLayoutPrefs,
  withLayoutMode,
  type LayoutMode,
  type LayoutPrefs,
} from '../../editor/layout'
import { toast } from '../../toast'
import { api } from '../../api'
import AgentSettingsSection from './AgentSettingsSection'
import LocalModelSection from './LocalModelSection'
import MnnModelSection from './MnnModelSection'
import PromptSection from './PromptSection'
import McpSection from './McpSection'
import MediaUsageSection from './MediaUsageSection'
import PrivacySection from './PrivacySection'
import SkillsSection from './SkillsSection'
import {
  getMermaidEnhance,
  setMermaidEnhance,
  subscribeMermaidEnhance,
} from '../../editor/mermaidPrefs'
import { IconBack, IconInfo } from '../../components/Icons'
import ChipRow from '../../components/ChipRow'
import { useLongPress } from '../../hooks'

interface Props {
  onBack: () => void
}

const THEME_OPTIONS: Array<{ key: Theme; label: string }> = [
  { key: 'light', label: '浅色' },
  { key: 'dark', label: '深色' },
  { key: 'system', label: '跟随系统' },
]

const INDENT_STYLE_OPTIONS: Array<{ key: IndentStyle; label: string }> = [
  { key: 'spaces', label: '空格' },
  { key: 'tabs', label: 'Tab' },
]

const INDENT_WIDTH_OPTIONS = INDENT_SIZES.map((size) => ({ key: size, label: `${size}` }))

const LAYOUT_MODE_OPTIONS: Array<{ key: LayoutMode; label: string }> = [
  { key: 'closed', label: '仅编辑' },
  { key: 'split', label: '分屏' },
  { key: 'preview', label: '仅预览' },
]

interface RowProps {
  meta: SaveStrategyMeta
  selected: boolean
  hintOpen: boolean
  tipOpen: boolean
  onSelect: () => void
  onToggleHint: () => void
  onToggleTip: () => void
}

/** One radio row; ⓘ opens a Popover on tap and a Tooltip on long-press. */
function SaveOptionRow({
  meta,
  selected,
  hintOpen,
  tipOpen,
  onSelect,
  onToggleHint,
  onToggleTip,
}: RowProps) {
  const { bind, didLongPress } = useLongPress(onToggleTip)
  return (
    <label className={`save-option ${selected ? 'active' : ''}`}>
      <input
        type="radio"
        name="save-strategy"
        className="save-radio-input"
        checked={selected}
        onChange={onSelect}
      />
      <span className="save-radio-dot" aria-hidden="true" />
      <span className="save-label">{meta.label}</span>
      <span
        role="button"
        tabIndex={0}
        className="save-info"
        aria-label="保存策略说明"
        onClick={(e) => {
          e.stopPropagation()
          if (didLongPress()) return
          onToggleHint()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggleHint()
          }
        }}
        {...bind()}
      >
        <IconInfo size={16} />
      </span>
      {selected && <span className="save-desc">{meta.desc}</span>}
      {hintOpen && (
        <span className="hint-bubble" role="tooltip">
          {meta.hint}
        </span>
      )}
      {tipOpen && (
        <span className="hint-bubble tooltip" role="tooltip">
          {meta.hint}
        </span>
      )}
    </label>
  )
}

export default function SettingsPage({ onBack }: Props) {
  const [theme, setTheme] = useState<Theme>(() => getStoredTheme())
  const [strategy, setStrategy] = useState(() => getSaveStrategy())
  const [editorPrefs, setEditorPrefsState] = useState(() => getEditorPrefs())
  const [layout, setLayout] = useState(() => getLayoutPrefs())
  const [hintFor, setHintFor] = useState<SaveStrategyKey | null>(null)
  const [tipFor, setTipFor] = useState<SaveStrategyKey | null>(null)
  const [reindexing, setReindexing] = useState(false)
  // Bumped when the local model section creates or switches the local chat entry.
  const [modelsReloadToken, setModelsReloadToken] = useState(0)
  const mermaidEnhance = useSyncExternalStore(
    subscribeMermaidEnhance,
    getMermaidEnhance,
    getMermaidEnhance,
  )

  const handleTheme = (t: Theme) => {
    setTheme(t)
    setStoredTheme(t)
  }

  const choose = (key: SaveStrategyKey) => {
    setStrategy((s) => {
      const next = { ...s, key }
      setSaveStrategy(next.key, next.intervalMin)
      return next
    })
  }

  const chooseInterval = (min: number) => {
    setStrategy((s) => {
      const next = { ...s, intervalMin: min }
      setSaveStrategy(next.key, next.intervalMin)
      return next
    })
  }

  const restoreDefault = () => {
    setStrategy({ key: DEFAULT_STRATEGY, intervalMin: DEFAULT_INTERVAL })
    setSaveStrategy(DEFAULT_STRATEGY, DEFAULT_INTERVAL)
  }

  const chooseIndentStyle = (indentStyle: IndentStyle) => {
    setEditorPrefsState((current) => {
      const next = { ...current, indentStyle }
      setEditorPrefs(next)
      return next
    })
  }

  const chooseIndentSize = (indentSize: number) => {
    setEditorPrefsState((current) => {
      const next = { ...current, indentSize }
      setEditorPrefs(next)
      return next
    })
  }

  const layoutMode = layoutModeOf(layout)

  const updateLayout = (next: LayoutPrefs) => {
    setLayout(next)
    setLayoutPrefs(next)
  }

  const chooseLayoutMode = (mode: LayoutMode) => {
    updateLayout(withLayoutMode(layout, mode))
  }

  const chooseRatio = (ratio: number) => {
    updateLayout({ ...layout, ratio })
  }

  const resetLayout = () => {
    clearLayoutPrefs()
    setLayout(DEFAULT_LAYOUT_PREFS)
    toast('已恢复默认布局设置')
  }

  const dismissHints = () => {
    setHintFor(null)
    setTipFor(null)
  }

  const rebuildSearchIndex = async () => {
    setReindexing(true)
    try {
      const count = await api.rebuildSearchIndex()
      toast(`已重建 ${count} 篇文档的检索索引`)
    } catch (e) {
      console.error('重建检索索引失败', e)
      toast('重建检索索引失败')
    } finally {
      setReindexing(false)
    }
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

        <AgentSettingsSection reloadToken={modelsReloadToken} />

        <LocalModelSection onModelsChanged={() => setModelsReloadToken((n) => n + 1)} />

        <MnnModelSection onModelsChanged={() => setModelsReloadToken((n) => n + 1)} />

        <PromptSection />

        <PrivacySection />

        <SkillsSection />

        <McpSection />

        <MediaUsageSection />

        <div className="settings-section-title">检索索引</div>
        <div className="form-field">
          <span className="form-label">全文搜索</span>
          <p className="settings-note">
            索引在每次写入时自动维护；若搜索结果异常，可手动重建。
          </p>
          <button
            type="button"
            className="restore-default"
            onClick={() => void rebuildSearchIndex()}
            disabled={reindexing}
          >
            {reindexing ? '正在重建…' : '重建检索索引'}
          </button>
        </div>

        <div className="settings-section-title">编辑与保存</div>
        <div className="form-field">
          <span className="form-label">保存策略</span>
          {SAVE_STRATEGIES.map((meta) => (
            <SaveOptionRow
              key={meta.key}
              meta={meta}
              selected={strategy.key === meta.key}
              hintOpen={hintFor === meta.key}
              tipOpen={tipFor === meta.key}
              onSelect={() => choose(meta.key)}
              onToggleHint={() => {
                setHintFor((cur) => (cur === meta.key ? null : meta.key))
                setTipFor(null)
              }}
              onToggleTip={() => {
                setTipFor((cur) => (cur === meta.key ? null : meta.key))
                setHintFor(null)
              }}
            />
          ))}
          {strategy.key === 'interval' && (
            <div className="save-interval">
              <ChipRow
                items={SAVE_INTERVALS.map((m) => ({ key: m, label: `${m} 分钟` }))}
                value={strategy.intervalMin}
                onChange={chooseInterval}
              />
            </div>
          )}
          <button type="button" className="restore-default" onClick={restoreDefault}>
            恢复默认
          </button>
        </div>

        <div className="settings-section-title">Markdown 编辑器</div>
        <div className="form-field">
          <span className="form-label">缩进方式</span>
          <ChipRow
            items={INDENT_STYLE_OPTIONS}
            value={editorPrefs.indentStyle}
            onChange={chooseIndentStyle}
          />
        </div>
        <div className="form-field">
          <span className="form-label">缩进宽度</span>
          <ChipRow
            items={INDENT_WIDTH_OPTIONS}
            value={editorPrefs.indentSize}
            onChange={chooseIndentSize}
          />
          <p className="settings-note">
            作用于空格缩进与 Tab 的显示宽度；重新打开笔记编辑页后生效。
          </p>
        </div>

        <div className="settings-section-title">图表预览</div>
        <div className="form-field">
          <span className="form-label">Mermaid 图表</span>
          <div className="settings-switch-row">
            <div className="settings-switch-text">
              <span className="settings-switch-title">视觉强化</span>
              <span className="settings-switch-desc">专业配色、间距与连线样式</span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={mermaidEnhance}
              aria-label="Mermaid 视觉强化"
              className={`settings-switch ${mermaidEnhance ? 'on' : ''}`}
              onClick={() => setMermaidEnhance(!mermaidEnhance)}
            >
              <span className="settings-switch-thumb" />
            </button>
          </div>
          <p className="settings-note">
            关闭后使用基础渲染风格；设置立即保存，无需重启应用。
          </p>
        </div>

        <div className="settings-section-title">预览布局</div>
        <div className="form-field">
          <span className="form-label">布局模式</span>
          <ChipRow
            items={LAYOUT_MODE_OPTIONS}
            value={layoutMode}
            onChange={chooseLayoutMode}
          />
          <p className="settings-note">「仅预览」会隐藏编辑区，适合专注阅读。</p>
        </div>
        <div className="form-field">
          <span className="form-label">编辑区 / 预览区比例</span>
          <div className="layout-ratio-row">
            <input
              type="range"
              className="layout-slider"
              min={MIN_SPLIT_RATIO}
              max={MAX_SPLIT_RATIO}
              step={1}
              value={layout.ratio}
              onChange={(e) => chooseRatio(Number(e.target.value))}
              aria-label="编辑区占比"
              aria-valuetext={`编辑区 ${layout.ratio}%，预览区 ${100 - layout.ratio}%`}
            />
            <span className="layout-ratio-value">
              {layout.ratio}% / {100 - layout.ratio}%
            </span>
          </div>
          <div className={`layout-diagram mode-${layoutMode}`} aria-hidden="true">
            {layoutMode !== 'preview' && (
              <div
                className="layout-diagram-pane editor"
                style={
                  layoutMode === 'split'
                    ? { flex: `0 0 calc((100% - 6px) * ${layout.ratio / 100})` }
                    : { flex: '1 1 auto' }
                }
              >
                编辑区
              </div>
            )}
            {layoutMode === 'split' && <div className="layout-diagram-handle" />}
            {layoutMode !== 'closed' && (
              <div className="layout-diagram-pane preview" style={{ flex: '1 1 0' }}>
                预览区
              </div>
            )}
          </div>
          <p className="settings-note">
            比例作用于分屏模式；在笔记页拖动分隔线也会同步保存这里显示的数值。
          </p>
          <button type="button" className="restore-default" onClick={resetLayout}>
            恢复默认设置
          </button>
        </div>
      </div>

      {(hintFor || tipFor) && <div className="popover-backdrop" onClick={dismissHints} />}
    </div>
  )
}
