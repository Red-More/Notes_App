import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { formatRelative, friendlyError } from '../../utils'
import type { Note } from '../../types'
import { ConfirmDialog } from '../../components/ui'
import { toast } from '../../toast'
import { IconBack, IconRestore, IconTrash } from '../../components/Icons'
import EmptyState from '../../components/EmptyState'

interface Props {
  onBack: () => void
}

export default function RecycleBinPage({ onBack }: Props) {
  const [notes, setNotes] = useState<Note[]>([])
  const [emptyConfirm, setEmptyConfirm] = useState(false)
  const [purgeTarget, setPurgeTarget] = useState<Note | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setNotes(await api.listDeletedNotes())
    } catch (e) {
      console.error(e)
      toast(friendlyError(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const list = await api.listDeletedNotes()
        if (!cancelled) setNotes(list)
      } catch (e) {
        console.error(e)
        if (!cancelled) toast(friendlyError(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  const handleRestore = async (n: Note) => {
    try {
      await api.restoreNotes([n.id])
      toast('已恢复')
      await load()
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const handlePurge = async (n: Note) => {
    setPurgeTarget(null)
    try {
      await api.purgeNotes([n.id])
      toast('已永久删除')
      await load()
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const handleEmpty = async () => {
    setEmptyConfirm(false)
    try {
      await api.emptyTrash()
      toast('回收站已清空')
      await load()
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  return (
    <div className="editor-page">
      <div className="editor-topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          <IconBack size={22} />
        </button>
        <span className="modal-title" style={{ marginLeft: 6 }}>
          回收站
        </span>
        <button
          type="button"
          className="btn btn-danger"
          style={{ flex: '0 0 auto', padding: '6px 16px', marginLeft: 'auto' }}
          onClick={() => setEmptyConfirm(true)}
        >
          清空
        </button>
      </div>

      <div className="page-scroll" style={{ paddingTop: 16 }}>
        {loading && notes.length === 0 ? (
          <div className="list-loading">加载中…</div>
        ) : notes.length === 0 ? (
          <EmptyState icon={<IconTrash size={44} />} text="回收站是空的" />
        ) : (
          notes.map((n) => (
            <div key={n.id} className="folder-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="folder-name">{n.title || '无标题'}</div>
                <div className="folder-count">
                  {n.folderName ?? '默认'} · {formatRelative(n.updatedAt)}
                </div>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="恢复"
                onClick={() => void handleRestore(n)}
              >
                <IconRestore size={19} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="永久删除"
                onClick={() => setPurgeTarget(n)}
              >
                <IconTrash size={19} />
              </button>
            </div>
          ))
        )}
      </div>

      {purgeTarget && (
        <ConfirmDialog
          title="永久删除"
          message={`确定永久删除"${purgeTarget.title || '无标题'}"吗？此操作不可撤销。`}
          confirmText="删除"
          danger
          onConfirm={() => void handlePurge(purgeTarget)}
          onCancel={() => setPurgeTarget(null)}
        />
      )}

      {emptyConfirm && (
        <ConfirmDialog
          title="清空回收站"
          message="确定清空回收站吗？将永久删除所有笔记，且不可恢复。"
          confirmText="清空"
          danger
          onConfirm={() => void handleEmpty()}
          onCancel={() => setEmptyConfirm(false)}
        />
      )}
    </div>
  )
}
