import type { ReactNode } from 'react'
import { IconSearch } from './Icons'

export interface PageHeaderAction {
  icon: ReactNode
  label: string
  onClick: () => void
}

interface PageHeaderProps {
  title: string
  action?: PageHeaderAction
  /** Multiple right-side actions; when provided, `action` is ignored. */
  actions?: PageHeaderAction[]
  search?: {
    placeholder: string
    value: string
    onChange: (v: string) => void
    /** Optional trailing element inside the search bar (e.g. a sort trigger). */
    action?: ReactNode
  }
}

/** Shared page header: title row + optional right actions + optional search bar. */
export default function PageHeader({ title, action, actions, search }: PageHeaderProps) {
  const headerActions = actions ?? (action ? [action] : [])
  return (
    <div className="page-header">
      <div className="page-title-row">
        <h1 className="page-title">{title}</h1>
        {headerActions.length > 0 && (
          <div className="page-header-actions">
            {headerActions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="icon-btn"
                onClick={a.onClick}
                aria-label={a.label}
              >
                {a.icon}
              </button>
            ))}
          </div>
        )}
      </div>
      {search && (
        <div className="search-bar">
          <IconSearch size={17} />
          <input
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder}
          />
          {search.action}
        </div>
      )}
    </div>
  )
}
