import type { MouseEvent, ReactNode, Ref } from 'react'
import { IconSearch } from './Icons'

export interface PageHeaderAction {
  icon: ReactNode
  label: string
  onClick: () => void
  /** Anchor for popovers that must point at this action button. */
  ref?: Ref<HTMLButtonElement>
}

interface PageHeaderProps {
  title: string
  action?: PageHeaderAction
  /** Multiple right-side actions; when provided, `action` is ignored. */
  actions?: PageHeaderAction[]
  /** Turns both title variants into buttons that open a scope picker. */
  onTitleClick?: (e: MouseEvent<HTMLButtonElement>) => void
  /** Trailing indicator rendered next to a clickable title. */
  titleTrailing?: ReactNode
  /** Replaces the title row (title + actions) while keeping the search bar mounted. */
  titleRow?: ReactNode
  /** Ref to the collapse wrapper around the search bar, for scroll-collapsing headers. */
  searchWrapRef?: Ref<HTMLDivElement>
  /** Ref to the collapse wrapper around the large left-aligned title. */
  largeTitleRef?: Ref<HTMLDivElement>
  search?: {
    placeholder: string
    value: string
    onChange: (v: string) => void
    /** Optional trailing element inside the search bar (e.g. a sort trigger). */
    action?: ReactNode
  }
}

/** Shared page header: title row + optional right actions + optional search bar. */
export default function PageHeader({
  title,
  action,
  actions,
  onTitleClick,
  titleTrailing,
  search,
  searchWrapRef,
  largeTitleRef,
  titleRow,
}: PageHeaderProps) {
  const headerActions = actions ?? (action ? [action] : [])
  const titleContent = (
    <>
      {title}
      {titleTrailing}
    </>
  )
  const titleButtonClass = 'page-title page-title-btn'
  return (
    <div className="page-header">
      <div className="page-title-row">
        {titleRow ?? (
          <>
            {onTitleClick ? (
              <button
                type="button"
                className={titleButtonClass}
                onClick={onTitleClick}
                aria-haspopup="dialog"
              >
                {titleContent}
              </button>
            ) : (
              <h1 className="page-title">{title}</h1>
            )}
            {headerActions.length > 0 && (
              <div className="page-header-actions">
                {headerActions.map((a) => (
                  <button
                    key={a.label}
                    ref={a.ref}
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
          </>
        )}
      </div>
      {search && largeTitleRef && (
        // Large title that collapses before the search bar; the centered title
        // above fades in as this row disappears (see useCollapsibleHeader). It
        // only renders when the collapse hook actually drives it.
        <div className="large-title-collapse" ref={largeTitleRef}>
          {onTitleClick ? (
            <button
              type="button"
              className="large-title large-title-btn"
              onClick={onTitleClick}
              aria-haspopup="dialog"
            >
              {titleContent}
            </button>
          ) : (
            <h1 className="large-title">{title}</h1>
          )}
        </div>
      )}
      {search && (
        <div className="search-collapse" ref={searchWrapRef}>
          <div className="search-bar">
            <IconSearch size={17} />
            <input
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              placeholder={search.placeholder}
            />
            {search.action}
          </div>
        </div>
      )}
    </div>
  )
}
