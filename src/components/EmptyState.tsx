import type { ReactNode } from 'react'

interface EmptyStateProps {
  icon: ReactNode
  text: string
}

/** Centered empty-state placeholder with an icon and a hint text. */
export default function EmptyState({ icon, text }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon}
      <div>{text}</div>
    </div>
  )
}
