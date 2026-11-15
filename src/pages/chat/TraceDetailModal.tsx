//! Unified card modal for every trace node.
//!
//! Inline disclosures only carry summaries; this sheet is the single place for
//! full details — tool diffs/arguments/results and reasoning text — so all
//! nodes share one shell, one height (3/5 of the screen) and one type scale.

import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { documentPath, documentRev, type ToolCard } from '../../agent/chatView'
import { DiffBody, DiffStats, Modal } from '../../components/ui'
import { diffLines, formatDuration, friendlyError } from '../../utils'

export type TraceDetailTarget =
  | { kind: 'tool'; card: ToolCard; path?: string }
  | { kind: 'thinking'; id: string; text: string; durationMs?: number; running: boolean }

interface Props {
  target: TraceDetailTarget
  onClose: () => void
}

export default function TraceDetailModal({ target, onClose }: Props) {
  if (target.kind === 'thinking') {
    return <ThinkingDetail target={target} onClose={onClose} />
  }
  return <ToolDetail card={target.card} activePath={target.path} onClose={onClose} />
}

// ------------------------------------------------------------- reasoning

function ThinkingDetail({
  target,
  onClose,
}: {
  target: Extract<TraceDetailTarget, { kind: 'thinking' }>
  onClose: () => void
}) {
  return (
    <Modal wide fill className="trace-detail-sheet" title="思考详情" onClose={onClose}>
      <div className="tool-detail">
        <header className="tool-detail-head">
          <div className="tool-detail-title">
            <span className="tool-detail-name">思考过程</span>
            <span className={`tool-detail-state ${target.running ? 'running' : 'done'}`}>
              <span className="tool-detail-dot" />
              {target.running ? '生成中' : '已完成'}
            </span>
          </div>
          {target.durationMs !== undefined && (
            <code className="tool-detail-path">耗时 {formatDuration(target.durationMs)}</code>
          )}
        </header>
        {/* Modal typography is larger than the inline scroll body. */}
        <div className="tool-detail-scroll">
          <pre className="trace-detail-thinking">
            {target.text.trim() === '' ? '（无思考内容）' : target.text}
          </pre>
        </div>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ tool

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

function ToolDetail({
  card,
  activePath,
  onClose,
}: {
  card: ToolCard
  activePath?: string
  onClose: () => void
}) {
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
    <Modal wide fill className="trace-detail-sheet" title={sheetTitle} onClose={onClose}>
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
