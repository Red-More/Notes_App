import { useState } from 'react'
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
  const { longPressProps, didLongPress } = useLongPress(onToggleTip)
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
        {...longPressProps}
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
  const [hintFor, setHintFor] = useState<SaveStrategyKey | null>(null)
  const [tipFor, setTipFor] = useState<SaveStrategyKey | null>(null)

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
      </div>

      {(hintFor || tipFor) && <div className="popover-backdrop" onClick={dismissHints} />}
    </div>
  )
}
