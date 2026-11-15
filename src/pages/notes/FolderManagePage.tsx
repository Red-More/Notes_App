import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { api } from '../../api'
import { useElasticOverscroll, useEdgeBack, useLongPress, useScrollContainer } from '../../hooks'
import { hapticTap } from '../../system/haptics'
import { exportTs, safeFileName, friendlyError } from '../../utils'
import type { Folder, FolderCrumb, FolderStats } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import {
  IconBack,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconEdit,
  IconExport,
  IconFolder,
  IconPin,
  IconSelectAll,
  IconTrash,
} from '../../components/Icons'
import RecycleBinPage from './RecycleBinPage'
import { usePhysicalBack } from '../../system/backButton'

interface Props {
  onBack: () => void
  /** Open the manager at the folder currently selected by the title. */
  initialFolderId?: number | null
  /** Namespace root, e.g. `/life/notes`, `/life/todos` or `/life`. */
  rootPath?: string
  /** Label of the root crumb; notes keeps its fixed 笔记 label. */
  rootLabel?: string
}

/** Synthetic id for the virtual default folder (notes with folder_id = NULL). */
const DEFAULT_FOLDER_ID = -1

export default function FolderManagePage({
  onBack,
  initialFolderId = null,
  rootPath = '/life/notes',
  rootLabel = '笔记',
}: Props) {
  const isNotesRoot = rootPath === '/life/notes'
  const [scopeId, setScopeId] = useState<number | null>(initialFolderId)
  const [crumbs, setCrumbs] = useState<FolderCrumb[]>([
    { id: null, name: rootLabel, path: rootPath },
  ])
  const [rootName, setRootName] = useState('默认')
  const [stats, setStats] = useState<FolderStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameTarget, setRenameTarget] = useState<Folder | 'default' | null>(null)
  const [renameName, setRenameName] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)

  // Same elastic overscroll as the tab lists.
  const { scrollRef, scrollEl } = useScrollContainer()
  const { pullDist, springing } = useElasticOverscroll(scrollEl)

  const load = useCallback(async () => {
    try {
      const [nextStats, path] = await Promise.all([
        api.listFolders(scopeId, rootPath, true),
        api.folderPath(scopeId, rootPath),
      ])
      setStats(nextStats)
      // Notes keeps its fixed 笔记 crumb; other namespaces use the folder's
      // own display name (待办 / AI 工作区 / basename).
      const rootNameFromPath = path[0]?.name ?? rootLabel
      setRootName(path[0]?.name ?? '默认')
      setCrumbs(
        path.length > 0
          ? [
              { ...path[0], name: isNotesRoot ? rootLabel : rootNameFromPath },
              ...path.slice(1),
            ]
          : [{ id: null, name: rootLabel, path: rootPath }],
      )
    } catch (e) {
      // The selected scope disappeared (deleted elsewhere): fall back to root.
      if (scopeId != null && (e as { code?: string })?.code === 'notFound') {
        setScopeId(null)
        return
      }
      console.error('加载文件夹失败', e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [scopeId, rootPath, rootLabel, isNotesRoot])

  useEffect(() => {
    void load()
  }, [load])

  const { bind, didLongPress, pressing } = useLongPress<Folder | 'default'>(
    () => {
      hapticTap()
      if (!selectMode) setSelectMode(true)
    },
    300,
    { hapticOnPress: true },
  )

  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  /** Drill into a folder level; the breadcrumb stays the single source of path. */
  const changeScope = (next: number | null) => {
    if (next === scopeId) return
    exitSelect()
    setStats(null)
    setLoading(true)
    setScopeId(next)
  }

  // Pop one level: recycle bin → selection → parent folder → notes tab.
  const handleBack = () => {
    if (trashOpen) setTrashOpen(false)
    else if (selectMode) exitSelect()
    else if (scopeId != null) changeScope(crumbs[crumbs.length - 2]?.id ?? null)
    else onBack()
  }
  useEdgeBack(handleBack)
  usePhysicalBack(handleBack)

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const folders = stats?.folders ?? []
  const atRoot = scopeId == null
  const defaultName = stats?.defaultFolderName ?? rootName
  const selectedIds = useMemo(() => [...selected], [selected])
  const selectedFolders = folders.filter((f) => selected.has(f.id))
  const includesDefault = isNotesRoot && atRoot && selected.has(DEFAULT_FOLDER_ID)
  const defaultOnly = includesDefault && selectedFolders.length === 0
  // The virtual default folder has no row to pin, so pin needs a real folder.
  const canPin = selectedFolders.length > 0
  const pinTarget = !selectedFolders.every((f) => f.isPinned === 1)
  const selectableIds = includesDefault
    ? [DEFAULT_FOLDER_ID, ...folders.map((f) => f.id)]
    : folders.map((f) => f.id)
  const allSelected = selectableIds.length > 0 && selected.size === selectableIds.length

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) {
      toast('请输入文件夹名称')
      return
    }
    try {
      await api.createFolder(name, scopeId, rootPath)
      setCreateOpen(false)
      setNewName('')
      toast('文件夹已创建')
      await load()
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const handleRename = async () => {
    if (!renameTarget) return
    const name = renameName.trim()
    if (!name) {
      toast('请输入文件夹名称')
      return
    }
    try {
      if (renameTarget === 'default') {
        await api.renameDefaultFolder(name)
      } else {
        await api.renameFolder({ id: renameTarget.id, name })
      }
      setRenameTarget(null)
      toast('已重命名')
      await load()
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const handleDelete = async () => {
    setDeleteConfirm(false)
    try {
      // Clear the default folder first: deleting real folders moves their notes
      // into the default bucket, and those must survive this operation.
      if (includesDefault) {
        const notes = await api.listNotes({ unclassified: true })
        if (notes.length > 0) await api.deleteNotes(notes.map((n) => n.id))
      }
      for (const id of selectedIds) {
        if (id !== DEFAULT_FOLDER_ID) await api.deleteFolder(id)
      }
      if (includesDefault && selectedFolders.length > 0) {
        toast(`${defaultName}文件夹已清空，${selectedFolders.length} 个文件夹已删除`)
      } else if (includesDefault) {
        toast(`${defaultName}文件夹已清空，笔记移入回收站`)
      } else {
        toast(isNotesRoot ? `已删除，原笔记移入${rootName}` : '已删除，内容已移入回收站')
      }
      exitSelect()
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handlePin = async () => {
    if (!canPin) return
    try {
      for (const f of selectedFolders) {
        await api.setFolderPinned({ id: f.id, pinned: pinTarget })
      }
      toast(pinTarget ? '已置顶' : '已取消置顶')
      exitSelect()
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handleEdit = () => {
    if (selected.size !== 1) {
      toast('请选择一个文件夹进行编辑')
      return
    }
    if (includesDefault) {
      setRenameTarget('default')
      setRenameName(defaultName)
    } else {
      const target = selectedFolders[0]
      setRenameTarget(target)
      setRenameName(target.name)
    }
  }

  const handleExport = async (f: Folder) => {
    if (f.noteCount === 0) {
      toast('该文件夹暂无笔记')
      return
    }
    try {
      const path = await save({
        defaultPath: `${safeFileName(f.name)}-${exportTs()}.zip`,
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      if (path == null) return
      await api.exportFolderTo({ folderId: f.id, destPath: path })
      toast('已导出')
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const handleRowClick = (folder: Folder) => {
    if (didLongPress()) return
    if (selectMode) {
      toggleSelected(folder.id)
    } else {
      changeScope(folder.id)
    }
  }

  if (trashOpen) {
    return <RecycleBinPage onBack={() => setTrashOpen(false)} defaultFolderName={rootName} />
  }

  return (
    <div className="editor-page">
      {selectMode ? (
        <div className="editor-topbar selection-topbar">
          <button type="button" className="icon-btn" onClick={exitSelect} aria-label="退出选择">
            <IconClose size={22} />
          </button>
          <span className="selection-count" aria-live="polite">
            已选择 {selected.size} 项
          </span>
          <button
            type="button"
            className={`icon-btn ${allSelected ? 'accent' : ''}`}
            onClick={() => setSelected(allSelected ? new Set() : new Set(selectableIds))}
            aria-label={allSelected ? '取消全选' : '全选'}
            aria-pressed={allSelected}
          >
            <IconSelectAll size={22} />
          </button>
        </div>
      ) : (
        <>
          <div className="editor-topbar">
            <button type="button" className="icon-btn" onClick={handleBack} aria-label="返回">
              <IconBack size={22} />
            </button>
            <span className="modal-title" style={{ marginLeft: 6 }}>
              文件夹管理
            </span>
            <button
              type="button"
              className="icon-btn"
              style={{ marginLeft: 'auto' }}
              onClick={() => setTrashOpen(true)}
              aria-label="回收站"
            >
              <IconTrash size={20} />
            </button>
          </div>
          <div className="folder-crumbs" aria-label="文件夹路径">
            {crumbs.map((crumb, index) => (
              <Fragment key={`${crumb.id ?? 'root'}-${index}`}>
                {index > 0 && <IconChevronRight size={14} className="folder-crumb-sep" />}
                <button
                  type="button"
                  className={`folder-crumb ${index === crumbs.length - 1 ? 'current' : ''}`}
                  onClick={() => {
                    if (index < crumbs.length - 1) changeScope(crumb.id)
                  }}
                >
                  {crumb.name}
                </button>
              </Fragment>
            ))}
          </div>
        </>
      )}

      <div className="page-scroll" style={{ paddingTop: 16 }} ref={scrollRef}>
        <div
          className={`scroll-content ${springing ? 'springing' : ''}`}
          style={pullDist ? { transform: `translateY(${pullDist}px)` } : undefined}
        >
          {/* The virtual default folder only exists in the notes namespace. */}
          {isNotesRoot && atRoot && (
            <div
              className={`folder-row virtual${selectMode && includesDefault ? ' selected' : ''} ${
                pressing === 'default' ? 'pressed' : ''
              }`}
              onClick={() => {
                if (didLongPress()) return
                if (selectMode) toggleSelected(DEFAULT_FOLDER_ID)
              }}
              {...bind('default')}
            >
              {selectMode && (
                <span className="check-dot">{includesDefault && <IconCheck size={14} />}</span>
              )}
              <div className="folder-icon">
                <IconFolder size={19} />
              </div>
              <div className="folder-main">
                <div className="folder-name">{defaultName}</div>
                <div className="folder-count">{stats?.unclassified ?? 0} 篇笔记</div>
              </div>
            </div>
          )}

          {folders.map((f) => (
            <div
              key={f.id}
              className={`folder-row ${selectMode && selected.has(f.id) ? 'selected' : ''} ${
                pressing === f ? 'pressed' : ''
              }`}
              onClick={() => handleRowClick(f)}
              {...bind(f)}
            >
              {selectMode && (
                <span className="check-dot">{selected.has(f.id) && <IconCheck size={14} />}</span>
              )}
              <div className="folder-icon">
                <IconFolder size={19} />
              </div>
              <div className="folder-main">
                <div className="folder-name">
                  {f.isPinned === 1 && <span className="pin-badge">📌</span>}
                  {f.name}
                </div>
                <div className="folder-count">
                  {f.noteCount} {isNotesRoot ? '篇笔记' : '项'}
                  {f.hasChildren ? ' · 含子文件夹' : ''}
                </div>
              </div>
              {!selectMode && (
                <>
                  {isNotesRoot && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="打包导出"
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleExport(f)
                      }}
                    >
                      <IconExport size={19} />
                    </button>
                  )}
                  <IconChevronRight size={18} className="folder-row-chevron" />
                </>
              )}
            </div>
          ))}

          {!loading && folders.length === 0 && (
            <div className="empty-state">
              <IconFolder size={44} />
              <div>{atRoot ? '还没有文件夹，点击下方按钮创建' : '还没有子文件夹，点击下方按钮创建'}</div>
            </div>
          )}
        </div>
      </div>

      {!selectMode ? (
        <div className="editor-bottombar" style={{ justifyContent: 'center' }}>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={() => setCreateOpen(true)}
          >
            {atRoot ? '新建文件夹' : '新建子文件夹'}
          </button>
        </div>
      ) : (
        <div className="editor-bottombar selection-actions">
          <button
            type="button"
            className="action-bar-btn"
            onClick={() => void handlePin()}
            disabled={!canPin}
          >
            <IconPin size={19} />
            {canPin && !pinTarget ? '取消置顶' : '置顶'}
          </button>
          <button type="button" className="action-bar-btn" onClick={handleEdit}>
            <IconEdit size={19} />
            编辑
          </button>
          <button
            type="button"
            className="action-bar-btn danger"
            onClick={() => setDeleteConfirm(true)}
            disabled={selected.size === 0}
          >
            <IconTrash size={19} />
            {defaultOnly ? '清空' : '删除'}
          </button>
        </div>
      )}

      {createOpen && (
        <Modal
          title={atRoot ? '新建文件夹' : '新建子文件夹'}
          onClose={() => setCreateOpen(false)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => void handleCreate()}>
              确定
            </button>
          }
        >
          <div className="form-field">
            <label className="form-label" htmlFor="folder-name">
              文件夹名称
            </label>
            <input
              id="folder-name"
              className="form-input"
              value={newName}
              maxLength={50}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="输入文件夹名称"
            />
          </div>
        </Modal>
      )}

      {renameTarget && (
        <Modal
          title="重命名文件夹"
          onClose={() => setRenameTarget(null)}
          footer={
            <button type="button" className="btn btn-primary" onClick={() => void handleRename()}>
              确定
            </button>
          }
        >
          <div className="form-field">
            <label className="form-label" htmlFor="rename-folder-name">
              文件夹名称
            </label>
            <input
              id="rename-folder-name"
              className="form-input"
              value={renameName}
              maxLength={50}
              onChange={(e) => setRenameName(e.target.value)}
            />
          </div>
        </Modal>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title={defaultOnly ? '清空文件夹' : '删除文件夹'}
          message={
            defaultOnly
              ? `确定清空"${defaultName}"文件夹吗？其中 ${stats?.unclassified ?? 0} 篇笔记将移入回收站。`
              : includesDefault
                ? `确定删除选中的 ${selectedFolders.length} 个文件夹，并清空"${defaultName}"文件夹（${stats?.unclassified ?? 0} 篇笔记将移入回收站）吗？`
                : isNotesRoot
                  ? `确定删除选中的 ${selectedFolders.length} 个文件夹吗？其中的笔记将移入"${rootName}"，子文件夹会一并删除。`
                  : `确定删除选中的 ${selectedFolders.length} 个文件夹吗？其中的内容将移入回收站，子文件夹会一并删除。`
          }
          confirmText={defaultOnly ? '清空' : '删除'}
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
