//! Standalone detail view for a trace node.
//!
//! Heavy content (diffs, file reads, arguments/results) lives here instead of
//! the conversation flow, so the chat keeps one-line summaries.

import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { documentPath, documentRev, type ToolCard } from '../../agent/chatView'
import { DiffBody, DiffStats, Modal } from '../../components/ui'
import { diffLines, friendlyError } from '../../utils'

interface Props {
  card: ToolCard
  /** File chosen from the changed-files list; defaults to the card's path. */
  activePath?: string
  onClose: () => void
}

type BodyState =
  | { status: 'loading' }
  | { status: 'diff'; oldText: string; newText: string }
  | { status: 'text'; text: string }
  | { status: 'error'; message: string }

const STATUS_LABEL: Record<ToolCard['status'], string> = {
  running: '执行中',
  done: '已完成',
  error: '失败',
}

async function readRevision(path: string, rev: number): Promise<string> {
  const result = await api.fsRead({ path, rev })
  if (result.kind !== 'file') throw new Error('该路径不是文件')
  return result.content
}

export default function ToolDetailModal({ card, activePath, onClose }: Props) {
  const primaryPath = documentPath(card)
  const path = activePath ?? primaryPath
  // Only the primary path carries the recorded revision; any other listed file
  // falls back to the readable result instead of diffing the wrong version.
  const rev =
    activePath === undefined || activePath === primaryPath ? documentRev(card) : null
  // Without a recorded revision, fall back to the readable arguments/result.
  const isDiff =
    card.status === 'done' &&
    path !== null &&
    rev !== null &&
    ['fs_write', 'fs_edit'].includes(card.toolName)
  const isRead = card.toolName === 'fs_read'
  const [body, setBody] = useState<BodyState>(() =>
    isDiff ? { status: 'loading' } : { status: 'text', text: card.text || '（无返回）' },
  )

  useEffect(() => {
    if (!isDiff || !path || rev === null) return
    let alive = true
    void (async () => {
      try {
        const [oldText, newText] = await Promise.all([
          rev > 1 ? readRevision(path, rev - 1) : Promise.resolve(''),
          readRevision(path, rev),
        ])
        if (alive) setBody({ status: 'diff', oldText, newText })
      } catch (error) {
        if (alive) setBody({ status: 'error', message: friendlyError(error) })
      }
    })()
    return () => {
      alive = false
    }
  }, [isDiff, path, rev])

  const rows = useMemo(
    () => (body.status === 'diff' ? diffLines(body.oldText, body.newText) : []),
    [body],
  )
  const name = path ? (path.split('/').pop() ?? card.toolName) : card.toolName
  const sheetTitle = isDiff ? '变更详情' : isRead ? '文件读取' : '工具详情'
  return (
    <Modal wide fill title={sheetTitle} onClose={onClose}>
      <div className="tool-detail">
        {/* Fixed inspector header: L1 name + status, L2 the full file path. */}
        <header className="tool-detail-head">
          <div className="tool-detail-title">
            <span className="tool-detail-name" title={name}>
              {name}
            </span>
            <span className={`tool-detail-state ${card.status}`}>
              <span className="tool-detail-dot" />
              {STATUS_LABEL[card.status]}
            </span>
          </div>
          {path && (
            <code className="tool-detail-path" title={path}>
              {path}
            </code>
          )}
        </header>
        {/* Non-scrolling diff stat bar pinned above the code viewport. */}
        {isDiff && body.status === 'diff' && (
          <div className="tool-detail-stats">
            <DiffStats rows={rows} />
          </div>
        )}
        <div className="tool-detail-scroll">
          {isDiff ? (
            body.status === 'loading' ? (
              <p className="settings-note">正在读取变更…</p>
            ) : body.status === 'error' ? (
              <p className="settings-note">{body.message}</p>
            ) : body.status === 'diff' ? (
              <DiffBody rows={rows} />
            ) : null
          ) : (
            <>
              <section className="tool-detail-section">
                <h4>参数</h4>
                <pre className="tool-detail-pre">{card.args || '{}'}</pre>
              </section>
              <section className="tool-detail-section">
                <h4>{isRead ? '文件内容' : '结果'}</h4>
                {body.status === 'loading' ? (
                  <p className="settings-note">正在读取…</p>
                ) : body.status === 'text' ? (
                  <pre className="tool-detail-pre">{body.text}</pre>
                ) : body.status === 'error' ? (
                  <p className="settings-note">{body.message}</p>
                ) : null}
              </section>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}
