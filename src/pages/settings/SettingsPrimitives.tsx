import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconCheck, IconChevronRight, IconInfo } from '../../components/Icons'
import type { SaveState } from './useSettingSave'

interface SettingsGroupProps {
  id?: string
  title: string
  hint?: string
  children: ReactNode
}

/** Task-oriented group: label above, rounded card below. */
export function SettingsGroup({ id, title, hint, children }: SettingsGroupProps) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section className="settings-group" id={id} aria-labelledby={headingId}>
      <h2 className="settings-group-title" id={headingId}>
        {title}
      </h2>
      {hint && <p className="settings-group-hint">{hint}</p>}
      <div className="settings-card">{children}</div>
    </section>
  )
}

/** Inline save lifecycle indicator rendered in the row's trailing slot. */
export function SaveStatus({ state, error }: { state: SaveState; error?: string | null }) {
  if (state === 'idle') return null
  if (state === 'saving') {
    return (
      <span className="settings-save saving" role="status">
        <span className="settings-spinner" aria-hidden="true" />
        保存中
      </span>
    )
  }
  if (state === 'saved') {
    return (
      <span className="settings-save saved" role="status">
        <IconCheck size={14} />
        已保存
      </span>
    )
  }
  return (
    <span className="settings-save error" role="status" title={error ?? undefined}>
      <IconInfo size={14} />
      失败·重试
    </span>
  )
}

interface SettingsRowProps {
  icon?: ReactNode
  /** Override the default tinted icon wrapper (e.g. a round avatar). */
  iconClass?: string
  title: string
  subtitle?: string
  /** Current value shown before the chevron. */
  value?: string
  status?: ReactNode
  chevron?: boolean
  expanded?: boolean
  onClick?: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
  ariaLabel?: string
}

function RowContent({
  icon,
  iconClass,
  title,
  subtitle,
  value,
  status,
  chevron,
  expanded,
}: Pick<
  SettingsRowProps,
  'icon' | 'iconClass' | 'title' | 'subtitle' | 'value' | 'status' | 'chevron' | 'expanded'
>) {
  return (
    <>
      {icon && <span className={iconClass ?? 'settings-row-icon'}>{icon}</span>}
      <span className="settings-row-body">
        <span className="settings-row-title">{title}</span>
        {subtitle && <span className="settings-row-subtitle">{subtitle}</span>}
      </span>
      <span className="settings-row-end">
        {value && <span className="settings-row-value">{value}</span>}
        {status}
        {chevron && (
          <span className={`settings-chevron ${expanded ? 'expanded' : ''}`}>
            <IconChevronRight size={18} />
          </span>
        )}
      </span>
    </>
  )
}

/** One tappable row; static rows render as plain content (no hit feedback). */
export function SettingsRow(props: SettingsRowProps) {
  const { onClick, disabled, tone = 'default', ariaLabel, title } = props
  const content = <RowContent {...props} />
  if (!onClick) {
    return <div className={`settings-row static ${tone}`}>{content}</div>
  }
  return (
    <button
      type="button"
      className={`settings-row ${tone}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? title}
      aria-expanded={props.chevron ? props.expanded === true : undefined}
    >
      {content}
    </button>
  )
}

interface SwitchRowProps {
  icon?: ReactNode
  title: string
  subtitle?: string
  checked: boolean
  onChange: (checked: boolean) => void
  status?: ReactNode
  disabled?: boolean
}

/** Row whose trailing control is a switch; the whole label area is static. */
export function SettingsSwitchRow({
  icon,
  title,
  subtitle,
  checked,
  onChange,
  status,
  disabled,
}: SwitchRowProps) {
  return (
    <div className="settings-row static">
      {icon && <span className="settings-row-icon">{icon}</span>}
      <span className="settings-row-body">
        <span className="settings-row-title">{title}</span>
        {subtitle && <span className="settings-row-subtitle">{subtitle}</span>}
      </span>
      {status}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        className={`settings-switch ${checked ? 'on' : ''}`}
        onClick={() => onChange(!checked)}
        disabled={disabled}
      >
        <span className="settings-switch-thumb" />
      </button>
    </div>
  )
}

interface ExpandableRowProps extends Omit<SettingsRowProps, 'onClick' | 'expanded' | 'chevron'> {
  open: boolean
  onToggle: () => void
  children: ReactNode
}

/** Row that reveals inline controls; collapsed by default on small screens. */
export function SettingsExpandableRow({
  open,
  onToggle,
  children,
  ...row
}: ExpandableRowProps) {
  return (
    <div className="settings-row-group">
      <SettingsRow {...row} onClick={onToggle} chevron expanded={open} />
      {open && <div className="settings-row-detail">{children}</div>}
    </div>
  )
}

interface InfoHintProps {
  /** Accessible label for the trigger button. */
  label: string
  children: ReactNode
}

/** Small info icon that reveals an explanatory bubble; outside taps close it. */
export function InfoHint({ label, children }: InfoHintProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <span className="info-hint" ref={rootRef}>
      <button
        type="button"
        className="info-hint-btn"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconInfo size={15} />
      </button>
      {open && (
        <span className="info-hint-pop" role="tooltip">
          {children}
        </span>
      )}
    </span>
  )
}
