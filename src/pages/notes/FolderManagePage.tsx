import { useCallback, useEffect, useMemo, useState } from 'react'
import { save } from '@tauri-apps/plugin-dialog'
import { api } from '../../api'
import { useLongPress } from '../../hooks'
import { exportTs, safeFileName, friendlyError } from '../../utils'
import type { Folder, FolderStats } from '../../types'
import { ConfirmDialog, Modal } from '../../components/ui'
import { toast } from '../../toast'
import { IconBack, IconExport, IconFolder, IconPin, IconTrash } from '../../components/Icons'
import RecycleBinPage from './RecycleBinPage'

interface Props {
  onBack: () => void
}

export default function FolderManagePage({ onBack }: Props) {
  const [stats, setStats] = useState<FolderStats | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [renameTarget, setRenameTarget] = useState<Folder | null>(null)
  const [renameName, setRenameName] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [trashOpen, setTrashOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setStats(await api.listFolders())
    } catch (e) {
      console.error('加载文件夹失败', e)
      toast(friendlyError(e))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const stats = await api.listFolders()
        if (!cancelled) setStats(stats)
      } catch (e) {
        console.error('加载文件夹失败', e)
        if (!cancelled) toast(friendlyError(e))
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  const { bind, didLongPress } = useLongPress(() => {
    if (!selectMode) setSelectMode(true)
  })

  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  const folders = stats?.folders ?? []
  const selectedIds = useMemo(() => [...selected], [selected])
  const selectedFolders = folders.filter((f) => selected.has(f.id))
  const pinTarget = !selectedFolders.every((f) => f.isPinned === 1)

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) {
      toast('请输入文件夹名称')
      return
    }
    try {
      await api.createFolder(name)
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
      await api.renameFolder({ id: renameTarget.id, name })
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
      for (const id of selectedIds) {
        await api.deleteFolder(id)
      }
      toast('已删除，原笔记移入默认')
      exitSelect()
      await load()
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    }
  }

  const handlePin = async () => {
    try {
      for (const id of selectedIds) {
        await api.setFolderPinned({ id, pinned: pinTarget })
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
    if (selectedFolders.length !== 1) {
      toast('请选择一个文件夹进行编辑')
      return
    }
    setRenameTarget(selectedFolders[0])
    setRenameName(selectedFolders[0].name)
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

  if (trashOpen) {
    return <RecycleBinPage onBack={() => setTrashOpen(false)} />
  }

  return (
    <div className="editor-page">
      <div className="editor-topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
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

      <div className="page-scroll" style={{ paddingTop: 16 }}>
        {/* Virtual rows */}
        <div className="folder-row virtual">
          <div className="folder-icon">
            <IconFolder size={19} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="folder-name">全部</div>
            <div className="folder-count">{stats?.total ?? 0} 篇笔记</div>
          </div>
        </div>
        <div className="folder-row virtual">
          <div className="folder-icon">
            <IconFolder size={19} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="folder-name">默认</div>
            <div className="folder-count">{stats?.unclassified ?? 0} 篇笔记</div>
          </div>
        </div>

        {folders.map((f) => (
          <div
            key={f.id}
            className={`folder-row ${selectMode && selected.has(f.id) ? 'selected' : ''}`}
            onClick={() => {
              if (didLongPress()) return
              if (selectMode) {
                setSelected((prev) => {
                  const next = new Set(prev)
                  if (next.has(f.id)) {
                    next.delete(f.id)
                  } else {
                    next.add(f.id)
                  }
                  return next
                })
              }
            }}
            {...bind()}
          >
            {selectMode && <span className="check-dot">{selected.has(f.id) && '✓'}</span>}
            <div className="folder-icon">
              <IconFolder size={19} />
            </div>
            <div style={{ flex: 1 }}>
              <div className="folder-name">
                {f.isPinned === 1 && <span className="pin-badge">📌</span>}
                {f.name}
              </div>
              <div className="folder-count">{f.noteCount} 篇笔记</div>
            </div>
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
          </div>
        ))}

        {folders.length === 0 && (
          <div className="empty-state">
            <IconFolder size={44} />
            <div>还没有文件夹，点击下方按钮创建</div>
          </div>
        )}
      </div>

      {!selectMode ? (
        <div className="editor-bottombar" style={{ justifyContent: 'center' }}>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={() => setCreateOpen(true)}
          >
            新建文件夹
          </button>
        </div>
      ) : (
        <div className="action-bar">
          <span className="action-bar-info">已选择 {selected.size} 项</span>
          <button type="button" className="action-bar-btn" onClick={() => void handlePin()}>
            <IconPin size={19} />
            {pinTarget ? '置顶' : '取消置顶'}
          </button>
          <button
            type="button"
            className="action-bar-btn danger"
            onClick={() => setDeleteConfirm(true)}
          >
            <IconTrash size={19} />
            删除
          </button>
          <button type="button" className="action-bar-btn" onClick={handleEdit}>
            编辑
          </button>
          <button type="button" className="action-bar-btn" onClick={exitSelect}>
            取消
          </button>
        </div>
      )}

      {createOpen && (
        <Modal
          title="新建文件夹"
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
          title="删除文件夹"
          message={`确定删除选中的 ${selected.size} 个文件夹吗？文件夹下的笔记不会删除，将变为"默认"。`}
          confirmText="删除"
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteConfirm(false)}
        />
      )}
    </div>
  )
}
