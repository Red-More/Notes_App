import { useSyncExternalStore, useState } from 'react'
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
  type EditorPrefs,
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
import {
  getMermaidEnhance,
  setMermaidEnhance,
  subscribeMermaidEnhance,
} from '../../editor/mermaidPrefs'
import { toast } from '../../toast'
import { IconImage, IconNote, IconSave, IconSettings, IconInfo } from '../../components/Icons'
import ChipRow from '../../components/ChipRow'
import { useLongPress } from '../../hooks'
import {
  SettingsExpandableRow,
  SettingsGroup,
  SettingsSwitchRow,
  SaveStatus,
} from './SettingsPrimitives'
import { useSettingSave } from './useSettingSave'

const INDENT_STYLE_OPTIONS: Array<{ key: EditorPrefs['indentStyle']; label: string }> = [
  { key: 'spaces', label: '空格' },
  { key: 'tabs', label: 'Tab' },
]

const INDENT_WIDTH_OPTIONS = INDENT_SIZES.map((size) => ({ key: size, label: `${size}` }))

const LAYOUT_MODE_OPTIONS: Array<{ key: LayoutMode; label: string }> = [
  { key: 'closed', label: '仅编辑' },
  { key: 'split', label: '分屏' },
  { key: 'preview', label: '仅预览' },
]

interface SaveOptionRowProps {
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
}: SaveOptionRowProps) {
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

export default function EditorSection() {
  const [strategy, setStrategy] = useState(() => getSaveStrategy())
  const [editorPrefs, setEditorPrefsState] = useState(() => getEditorPrefs())
  const [layout, setLayout] = useState(() => getLayoutPrefs())
  const [hintFor, setHintFor] = useState<SaveStrategyKey | null>(null)
  const [tipFor, setTipFor] = useState<SaveStrategyKey | null>(null)
  const [strategyOpen, setStrategyOpen] = useState(false)
  const [indentOpen, setIndentOpen] = useState(false)
  const [layoutOpen, setLayoutOpen] = useState(false)
  const strategySave = useSettingSave()
  const indentSave = useSettingSave()
  const layoutSave = useSettingSave()
  const mermaidSave = useSettingSave()
  const mermaidEnhance = useSyncExternalStore(
    subscribeMermaidEnhance,
    getMermaidEnhance,
    getMermaidEnhance,
  )

  const strategyMeta = SAVE_STRATEGIES.find((meta) => meta.key === strategy.key)
  const strategyValue =
    strategy.key === 'interval'
      ? `定时 · ${strategy.intervalMin} 分钟`
      : (strategyMeta?.label ?? '智能保存')
  const indentValue = `${editorPrefs.indentStyle === 'tabs' ? 'Tab' : '空格'} · ${editorPrefs.indentSize}`
  const layoutMode = layoutModeOf(layout)
  const layoutModeLabel =
    LAYOUT_MODE_OPTIONS.find((option) => option.key === layoutMode)?.label ?? '仅编辑'
  const layoutValue =
    layoutMode === 'split'
      ? `分屏 · ${layout.ratio}% / ${100 - layout.ratio}%`
      : layoutModeLabel

  const chooseStrategy = (key: SaveStrategyKey) => {
    const next = { ...strategy, key }
    setStrategy(next)
    void strategySave.run(() => setSaveStrategy(next.key, next.intervalMin))
  }

  const chooseInterval = (min: number) => {
    const next = { ...strategy, intervalMin: min }
    setStrategy(next)
    void strategySave.run(() => setSaveStrategy(next.key, next.intervalMin))
  }

  const restoreStrategy = () => {
    const next = { key: DEFAULT_STRATEGY, intervalMin: DEFAULT_INTERVAL }
    setStrategy(next)
    void strategySave.run(() => setSaveStrategy(next.key, next.intervalMin))
  }

  const chooseIndent = (patch: Partial<EditorPrefs>) => {
    const next = { ...editorPrefs, ...patch }
    setEditorPrefsState(next)
    void indentSave.run(() => setEditorPrefs(next))
  }

  const updateLayout = (next: LayoutPrefs) => {
    setLayout(next)
    void layoutSave.run(() => setLayoutPrefs(next))
  }

  const resetLayout = () => {
    clearLayoutPrefs()
    setLayout(DEFAULT_LAYOUT_PREFS)
    void layoutSave.run(() => setLayoutPrefs(DEFAULT_LAYOUT_PREFS))
    toast('已恢复默认布局设置')
  }

  return (
    <SettingsGroup id="settings-editor" title="编辑与保存">
      <SettingsExpandableRow
        icon={<IconSave size={20} />}
        title="保存策略"
        subtitle={strategyMeta?.desc}
        value={strategyValue}
        status={<SaveStatus state={strategySave.state} error={strategySave.error} />}
        open={strategyOpen}
        onToggle={() => setStrategyOpen((open) => !open)}
      >
        {SAVE_STRATEGIES.map((meta) => (
          <SaveOptionRow
            key={meta.key}
            meta={meta}
            selected={strategy.key === meta.key}
            hintOpen={hintFor === meta.key}
            tipOpen={tipFor === meta.key}
            onSelect={() => chooseStrategy(meta.key)}
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
          <div className="settings-detail-field">
            <span className="settings-detail-label">保存间隔</span>
            <ChipRow
              items={SAVE_INTERVALS.map((min) => ({ key: min, label: `${min} 分钟` }))}
              value={strategy.intervalMin}
              onChange={chooseInterval}
            />
          </div>
        )}
        <button type="button" className="restore-default" onClick={restoreStrategy}>
          恢复默认
        </button>
      </SettingsExpandableRow>

      <SettingsExpandableRow
        icon={<IconNote size={20} />}
        title="编辑器缩进"
        subtitle="影响 Markdown 编辑器的缩进方式与显示宽度"
        value={indentValue}
        status={<SaveStatus state={indentSave.state} error={indentSave.error} />}
        open={indentOpen}
        onToggle={() => setIndentOpen((open) => !open)}
      >
        <div className="settings-detail-field">
          <span className="settings-detail-label">缩进方式</span>
          <ChipRow
            items={INDENT_STYLE_OPTIONS}
            value={editorPrefs.indentStyle}
            onChange={(indentStyle) => chooseIndent({ indentStyle })}
          />
        </div>
        <div className="settings-detail-field">
          <span className="settings-detail-label">缩进宽度</span>
          <ChipRow
            items={INDENT_WIDTH_OPTIONS}
            value={editorPrefs.indentSize}
            onChange={(indentSize) => chooseIndent({ indentSize })}
          />
        </div>
        <p className="settings-detail-note">重新打开笔记编辑页后生效。</p>
      </SettingsExpandableRow>

      <SettingsExpandableRow
        icon={<IconSettings size={20} />}
        title="预览布局"
        subtitle="分屏或专注阅读；比例会与笔记页分隔线同步"
        value={layoutValue}
        status={<SaveStatus state={layoutSave.state} error={layoutSave.error} />}
        open={layoutOpen}
        onToggle={() => setLayoutOpen((open) => !open)}
      >
        <ChipRow
          items={LAYOUT_MODE_OPTIONS}
          value={layoutMode}
          onChange={(mode) => updateLayout(withLayoutMode(layout, mode))}
        />
        <div className="layout-ratio-row">
          <input
            type="range"
            className="layout-slider"
            min={MIN_SPLIT_RATIO}
            max={MAX_SPLIT_RATIO}
            step={1}
            value={layout.ratio}
            onChange={(e) => updateLayout({ ...layout, ratio: Number(e.target.value) })}
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
        <p className="settings-detail-note">「仅预览」会隐藏编辑区，适合专注阅读。</p>
        <button type="button" className="restore-default" onClick={resetLayout}>
          恢复默认设置
        </button>
      </SettingsExpandableRow>

      <SettingsSwitchRow
        icon={<IconImage size={20} />}
        title="Mermaid 视觉强化"
        subtitle="专业配色、间距与连线样式；关闭后使用基础渲染"
        checked={mermaidEnhance}
        onChange={(next) =>
          void mermaidSave.run(() => setMermaidEnhance(next))
        }
        status={<SaveStatus state={mermaidSave.state} error={mermaidSave.error} />}
      />
    </SettingsGroup>
  )
}
