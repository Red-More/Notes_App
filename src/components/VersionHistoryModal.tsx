import { useCallback, useEffect, useState } from 'react'
import { docApi } from '../api'
import type { DocVersion } from '../types'
import { formatDateTime, friendlyError } from '../utils'
import { toast } from '../toast'
import { ConfirmDialog, Modal } from './ui'

interface Props {
  docId: number
  title: string
  onClose: () => void
  /** Called after a restore so the owning page can reload its list. */
  onRestored?: () => void
}

/** 通用历史版本面板：覆盖全部文档类型，恢复时追加新 rev，不覆盖历史。 */
export default function VersionHistoryModal({ docId, title, onClose, onRestored }: Props) {
  const [versions, setVersions] = useState<DocVersion[]>([])
  const [headRev, setHeadRev] = useState(0)
  const [loading, setLoading] = useState(true)
  const [restoreTarget, setRestoreTarget] = useState<DocVersion | null>(null)

  const load = useCallback(async () => {
    try {
      const [doc, list] = await Promise.all([
        docApi.get(docId),
        docApi.listVersions(docId, true),
      ])
      setHeadRev(doc.rev)
      setVersions(list)
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setLoading(false)
    }
  }, [docId])

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const [doc, list] = await Promise.all([
          docApi.get(docId),
          docApi.listVersions(docId, true),
        ])
        if (cancelled) return
        setHeadRev(doc.rev)
        setVersions(list)
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
  }, [docId])

  const confirmRestore = async () => {
    if (!restoreTarget) return
    const target = restoreTarget
    setRestoreTarget(null)
    try {
      await docApi.restoreVersion(target.id)
      toast(`已恢复到第 ${target.versionNumber} 版`)
      onRestored?.()
      await load()
    } catch (error) {
      toast(friendlyError(error))
    }
  }

  return (
    <>
      <Modal title={`历史版本 · ${title}`} onClose={onClose}>
        {loading ? (
          <p className="settings-note">加载中…</p>
        ) : versions.length === 0 ? (
          <div className="empty-state">暂无版本</div>
        ) : (
          versions.map((version) => {
            const isHead = version.versionNumber === headRev
            return (
              <div key={version.id} className="version-item">
                <div className="version-main">
                  <div className="version-head">
                    <span className="version-no">第 {version.versionNumber} 版</span>
                    {version.isManual === 1 && <span className="version-label">手工</span>}
                    {isHead && <span className="version-label">当前</span>}
                  </div>
                  <div className="version-title">{version.title || '无标题'}</div>
                  <div className="version-time">{formatDateTime(version.createdAt)}</div>
                </div>
                <div className="version-actions">
                  <button
                    type="button"
                    className="restore-default"
                    aria-label={`恢复第 ${version.versionNumber} 版`}
                    disabled={isHead}
                    onClick={() => setRestoreTarget(version)}
                  >
                    恢复
                  </button>
                </div>
              </div>
            )
          })
        )}
      </Modal>

      {restoreTarget && (
        <ConfirmDialog
          title="恢复版本"
          message={`确定恢复到第 ${restoreTarget.versionNumber} 版吗？当前内容会保留在历史中，恢复会追加一个新版本。`}
          confirmText="恢复"
          onConfirm={() => void confirmRestore()}
          onCancel={() => setRestoreTarget(null)}
        />
      )}
    </>
  )
}
