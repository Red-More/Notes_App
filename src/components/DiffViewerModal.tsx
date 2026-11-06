import { useCallback, useEffect, useState } from 'react'
import { api, docApi } from '../api'
import { diffLines, friendlyError, type DiffRow } from '../utils'
import { toast } from '../toast'
import { Modal } from './ui'

interface FileDiff {
  path: string
  status: 'modified' | 'new' | 'reverted'
  added: number
  removed: number
  rows: DiffRow[]
}

interface Props {
  paths: string[]
  title: string
  onClose: () => void
}

/** 一次回复内的文件变更：手风琴列表 + 行内 diff + 单文件/全部撤销。 */
export default function DiffViewerModal({ paths, title, onClose }: Props) {
  const [files, setFiles] = useState<FileDiff[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [reverting, setReverting] = useState(false)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        // Only the changed paths are needed; skip bodies for the whole store.
        const docs = paths.length
          ? await docApi.list({ paths, includeContent: false })
          : []
        const result: FileDiff[] = []
        for (const path of paths) {
          const doc = docs.find((item) => item.path === path)
          if (!doc) continue
          const versions = await docApi.listVersions(doc.id, true)
          const previous = versions
            .filter((version) => version.versionNumber < doc.rev)
            .sort((a, b) => b.versionNumber - a.versionNumber)[0]
          // Autosave mutates the head in place, so the live body always comes
          // from doc_get; version bodies are replayed on demand.
          const current = (await docApi.get(doc.id)).content
          const rows = previous
            ? diffLines(await docApi.versionContent(previous.id), current)
            : diffLines('', current)
          result.push({
            path,
            status: previous ? 'modified' : 'new',
            added: rows.filter((row) => row.type === 'add').length,
            removed: rows.filter((row) => row.type === 'del').length,
            rows,
          })
        }
        if (!cancelled) {
          setFiles(result)
          setExpanded(result[0]?.path ?? null)
        }
      } catch (error) {
        if (!cancelled) toast(friendlyError(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [paths])

  const revert = useCallback(async (path: string) => {
    try {
      await api.restorePreviousDocRevision(path)
      setFiles((prev) =>
        prev.map((file) =>
          file.path === path ? { ...file, status: 'reverted', added: 0, removed: 0, rows: [] } : file,
        ),
      )
      toast('已撤销该文件的变更')
    } catch (error) {
      toast(friendlyError(error))
    }
  }, [])

  const revertAll = useCallback(async () => {
    // New files have no previous revision, so only modified files can roll back.
    const pending = files.filter((file) => file.status === 'modified')
    if (pending.length === 0) return
    setReverting(true)
    try {
      for (const file of pending) {
        await api.restorePreviousDocRevision(file.path)
      }
      setFiles((prev) =>
        prev.map((file) =>
          file.status === 'modified'
            ? { ...file, status: 'reverted', added: 0, removed: 0, rows: [] }
            : file,
        ),
      )
      toast('已撤销本次全部变更')
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setReverting(false)
    }
  }, [files])

  const totalAdded = files.reduce((sum, file) => sum + file.added, 0)
  const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0)

  return (
    <Modal
      title={`变更 · ${title}`}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn-plain"
            disabled={
              reverting || files.every((file) => file.status !== 'modified')
            }
            onClick={() => void revertAll()}
          >
            {reverting ? '撤销中…' : '全部撤销'}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {loading ? (
        <p className="settings-note">正在读取变更…</p>
      ) : files.length === 0 ? (
        <div className="empty-state">没有可对比的文件变更</div>
      ) : (
        <>
          <div className="diff-stats">
            <span className="add">+{totalAdded} 行</span>
            <span className="del">-{totalRemoved} 行</span>
            <span className="settings-note">{files.length} 个文件</span>
          </div>
          {files.map((file) => (
            <div key={file.path} className="diff-file">
              <div className="diff-file-head">
                <button
                  type="button"
                  className="diff-file-main"
                  onClick={() => setExpanded((prev) => (prev === file.path ? null : file.path))}
                  aria-expanded={expanded === file.path}
                >
                  <span className="chat-file-link">{file.path}</span>
                  <span className="diff-file-stats">
                    <span className="add">+{file.added}</span>
                    <span className="del">-{file.removed}</span>
                  </span>
                </button>
                {file.status === 'reverted' ? (
                  <span className="settings-note">已撤销</span>
                ) : file.status === 'modified' ? (
                  <button
                    type="button"
                    className="restore-default"
                    onClick={() => void revert(file.path)}
                  >
                    撤销
                  </button>
                ) : null}
              </div>
              {file.status === 'new' && (
                <p className="settings-note">新建文件（无历史版本，无法撤销）</p>
              )}
              {expanded === file.path && file.rows.length > 0 && (
                <div className="diff-body">
                  {file.rows.map((row, index) => (
                    <div key={index} className={`diff-row ${row.type}`}>
                      <span className="no">
                        {row.type === 'add' ? row.newNo : (row.oldNo ?? '')}
                      </span>
                      <span>{row.text || ' '}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </Modal>
  )
}
