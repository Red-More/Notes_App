//! Shared action row under one message bubble.
//!
//! The role only controls alignment; the caller passes the allowed actions so
//! support for new roles or extra actions stays in one place.

import type { ReactNode } from 'react'

export interface MessageAction {
  key: string
  label: string
  /** Outline glyph; when present the row renders a compact icon button. */
  icon?: ReactNode
  disabled?: boolean
  onClick: () => void
}

interface MessageActionsProps {
  role: 'user' | 'assistant'
  actions: MessageAction[]
  /** Extra widgets rendered after the buttons (usage, context ring). */
  trailing?: ReactNode
}

export default function MessageActions({ role, actions, trailing }: MessageActionsProps) {
  if (actions.length === 0 && !trailing) return null
  return (
    <div className={`chat-actions ${role}`}>
      {actions.map((action) => (
        <button
          key={action.key}
          type="button"
          className={action.icon ? 'chat-action icon' : 'chat-action'}
          aria-label={action.label}
          title={action.label}
          disabled={action.disabled}
          onClick={action.onClick}
        >
          {action.icon ?? action.label}
        </button>
      ))}
      {trailing}
    </div>
  )
}
