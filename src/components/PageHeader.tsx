import type { ReactNode } from 'react'
import { IconSearch } from './Icons'

interface PageHeaderAction {
  icon: ReactNode
  label: string
  onClick: () => void
}

interface PageHeaderProps {
  title: string
  action?: PageHeaderAction
  search?: { placeholder: string; value: string; onChange: (v: string) => void }
}

/** Shared page header: title row + optional right action + optional search bar. */
export default function PageHeader({ title, action, search }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div className="page-title-row">
        <h1 className="page-title">{title}</h1>
        {action && (
          <button
            type="button"
            className="icon-btn"
            onClick={action.onClick}
            aria-label={action.label}
          >
            {action.icon}
          </button>
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
        </div>
      )}
    </div>
  )
}
