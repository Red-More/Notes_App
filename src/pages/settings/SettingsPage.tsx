import { useSyncExternalStore, useState, useEffect } from 'react'
import { chatApi } from '../../api'
import type { AgentSettings } from '../../types'
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
import { friendlyError } from '../../utils'
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

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Gemini',
  mock: 'Mock（离线）',
}

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
  const [agent, setAgent] = useState<AgentSettings | null>(null)
  const [modelDraft, setModelDraft] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [agentSaving, setAgentSaving] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const settings = await chatApi.settings()
        setAgent(settings)
        setModelDraft(settings.model)
      } catch (e) {
        console.error('读取 Agent 配置失败', e)
      }
    })()
  }, [])

  const keyConfigured = agent?.keyConfigured.some(
    (item) => item.provider === agent.provider && item.configured,
  )

  const chooseProvider = async (provider: string) => {
    if (!agent) return
    const prev = agent
    setAgent({ ...agent, provider })
    try {
      await chatApi.setSettings({ provider, model: modelDraft.trim() || agent.model })
      toast(`已切换到 ${PROVIDER_LABELS[provider] ?? provider}`)
    } catch (e) {
      // 保存失败回滚 UI，避免显示未持久化的厂商。
      setAgent(prev)
      toast(friendlyError(e))
    }
  }

  const saveModel = async () => {
    if (!agent) return
    const model = modelDraft.trim()
    if (!model) {
      toast('请填写模型名')
      return
    }
    setAgentSaving(true)
    try {
      await chatApi.setSettings({ provider: agent.provider, model })
      setAgent({ ...agent, model })
      toast('模型已保存')
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setAgentSaving(false)
    }
  }

  const saveKey = async () => {
    if (!agent) return
    const key = keyDraft.trim()
    if (!key) {
      toast('请粘贴 API Key')
      return
    }
    try {
      await chatApi.setKey({ provider: agent.provider, key })
      setKeyDraft('')
      setAgent({
        ...agent,
        keyConfigured: agent.keyConfigured.map((item) =>
          item.provider === agent.provider ? { ...item, configured: true } : item,
        ),
      })
      toast('密钥已保存到本机（不会进入网页环境）')
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const deleteKey = async () => {
    if (!agent) return
    try {
      await chatApi.deleteKey(agent.provider)
      setAgent({
        ...agent,
        keyConfigured: agent.keyConfigured.map((item) =>
          item.provider === agent.provider ? { ...item, configured: false } : item,
        ),
      })
      toast('密钥已删除')
    } catch (e) {
      toast(friendlyError(e))
    }
  }
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

        <div className="settings-section-title">AI 助理</div>
        {agent ? (
          <>
            <div className="form-field">
              <span className="form-label">厂商</span>
              <ChipRow
                items={agent.providers.map((provider) => ({
                  key: provider,
                  label: PROVIDER_LABELS[provider] ?? provider,
                }))}
                value={agent.provider}
                onChange={(provider) => void chooseProvider(provider)}
              />
              <p className="settings-note">
                provider 只能是枚举内的厂商；请求由 Rust 发出，WebView 不直连模型服务。
              </p>
            </div>
            <div className="form-field">
              <label className="form-label" htmlFor="agent-model">
                模型
              </label>
              <input
                id="agent-model"
                className="form-input"
                value={modelDraft}
                onChange={(e) => setModelDraft(e.target.value)}
                placeholder="如 gpt-4o-mini / claude-sonnet-4-6 / gemini-2.0-flash"
              />
              <button
                type="button"
                className="restore-default"
                disabled={agentSaving}
                onClick={() => void saveModel()}
              >
                保存模型
              </button>
            </div>
            {agent.provider !== 'mock' && (
              <div className="form-field">
                <span className="form-label">
                  API Key（{keyConfigured ? '已配置' : '未配置'}）
                </span>
                <input
                  className="form-input"
                  type="password"
                  value={keyDraft}
                  autoComplete="off"
                  placeholder={keyConfigured ? '已保存；粘贴新值可覆盖' : '粘贴 API Key'}
                  onChange={(e) => setKeyDraft(e.target.value)}
                />
                <div className="chat-key-actions">
                  <button type="button" className="restore-default" onClick={() => void saveKey()}>
                    保存密钥
                  </button>
                  {keyConfigured && (
                    <button type="button" className="restore-default" onClick={() => void deleteKey()}>
                      删除密钥
                    </button>
                  )}
                </div>
                <p className="settings-note">
                  Android 上密钥写入 Keystore 加密存储（加密密钥不可导出）；桌面开发机为
                  应用私有文件（0600）。密钥不写数据库、不下发网页环境、不写日志。
                </p>
              </div>
            )}
          </>
        ) : (
          <div className="form-field">
            <p className="settings-note">读取 Agent 配置…</p>
          </div>
        )}

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
