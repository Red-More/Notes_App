import { Fragment, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { api } from '../api'
import type { Folder, FolderCrumb, FolderScope } from '../types'
import { friendlyError } from '../utils'
import { toast } from '../toast'
import { IconCheck, IconChevronRight, IconFolder } from './Icons'
import { OverlayPortal } from './ui'

interface Props {
  /** Label of the topmost crumb, e.g. 全部文件 or 笔记. */
  rootLabel: string
  /** Namespace root: `/life` browses the whole VFS, `/life/notes` only notes. */
  rootPath: string
  /** Currently selected folder; null means the namespace root. */
  value: number | null
  /** Path of the current selection, used to highlight a null-id namespace root. */
  valuePath?: string
  onSelect: (scope: FolderScope) => void
  onClose: () => void
  /** Whether the namespace root itself can be selected (VFS root cannot). */
  rootSelectable?: boolean
  /** Anchored placement computed by the caller. */
  style?: CSSProperties
}

/**
 * Cascade folder picker rooted at `rootPath`.
 *
 * Every level lazy-loads only its direct child folders, breadcrumbs jump back
 * up, and any row can be selected in place. Folders without children confirm
 * on tap; folders with children drill down, with the trailing check selecting
 * the folder itself. Using `/life` as the root exposes the whole virtual file
 * system; using `/life/notes` keeps the picker inside the notes namespace.
 */
export default function FolderScopePicker({
  rootLabel,
  rootPath,
  value,
  valuePath,
  onSelect,
  onClose,
  rootSelectable = true,
  style,
}: Props) {
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>([
    { id: null, name: rootLabel, path: rootPath },
  ])
  const [folders, setFolders] = useState<Folder[]>([])
  const [loading, setLoading] = useState(true)
  const current = crumbs[crumbs.length - 1]
  const canSelectCurrent = current.id != null || rootSelectable
  const isSelected = (id: number | null, path: string) =>
    value != null ? id === value : valuePath != null && path === valuePath

  // Open on the parent folder's contents so the selected folder and all its
  // siblings are directly switchable; the parent crumb still allows going up.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const path = await api.folderPath(value, rootPath)
        if (cancelled || path.length === 0) return
        const level = value != null && path.length > 1 ? path.slice(0, -1) : path
        setCrumbs([{ ...level[0], name: rootLabel }, ...level.slice(1)])
      } catch {
        // Unresolvable selections fall back to the namespace root.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [value, rootPath, rootLabel])

  // Lazy-load only the children of the level being browsed.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const stats = await api.listFolders(current.id, rootPath)
        if (!cancelled) setFolders(stats.folders)
      } catch (e) {
        if (!cancelled) toast(friendlyError(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [current.id, rootPath])

  const choose = (scope: FolderScope) => {
    onSelect(scope)
    onClose()
  }

  const position = useMemo(
    () => ({ width: 280, maxHeight: '50vh', ...style }) as CSSProperties,
    [style],
  )

  return (
    <OverlayPortal>
      <div className="scope-backdrop" onClick={onClose} />
      <div className="folder-popover folder-picker" style={position} role="dialog" aria-label="选择文件夹">
        <div className="folder-picker-crumbs">
          {crumbs.map((crumb, index) => (
            <Fragment key={`${crumb.id ?? 'root'}-${index}`}>
              {index > 0 && <IconChevronRight size={14} className="folder-crumb-sep" />}
              <button
                type="button"
                className={`folder-crumb ${index === crumbs.length - 1 ? 'current' : ''}`}
                onClick={() => {
                  if (index < crumbs.length - 1) setCrumbs((prev) => prev.slice(0, index + 1))
                }}
              >
                {crumb.name}
              </button>
            </Fragment>
          ))}
        </div>

        {canSelectCurrent && (
          <button
            type="button"
            className="option-row folder-picker-current"
            onClick={() => choose({ id: current.id, name: current.name, path: current.path })}
          >
            <span>{`选择「${current.name}」`}</span>
            {isSelected(current.id, current.path) && <span className="row-check">当前</span>}
          </button>
        )}

        {loading ? (
          <div className="folder-picker-empty">加载中…</div>
        ) : folders.length === 0 ? (
          <div className="folder-picker-empty">没有子文件夹</div>
        ) : (
          folders.map((folder) => (
            <div className="folder-picker-row" key={folder.id}>
              <button
                type="button"
                className="folder-picker-enter"
                onClick={() => {
                  // A leaf folder needs no extra step: tapping it confirms.
                  if (!folder.hasChildren) {
                    choose({ id: folder.id, name: folder.name, path: folder.path })
                    return
                  }
                  setCrumbs((prev) => [
                    ...prev,
                    { id: folder.id, name: folder.name, path: folder.path },
                  ])
                }}
              >
                <IconFolder size={18} />
                <span className="folder-picker-name">{folder.name}</span>
                <span className="folder-picker-count">{folder.noteCount}</span>
                {folder.hasChildren && <IconChevronRight size={16} />}
              </button>
              <button
                type="button"
                className={`folder-picker-pick ${isSelected(folder.id, folder.path) ? 'active' : ''}`}
                aria-label={`选择 ${folder.name}`}
                onClick={() => choose({ id: folder.id, name: folder.name, path: folder.path })}
              >
                <IconCheck size={16} />
              </button>
            </div>
          ))
        )}
      </div>
    </OverlayPortal>
  )
}
