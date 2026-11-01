import { useCallback, useEffect, useState } from 'react'
import { mediaApi } from '../../api'
import type { MediaJob, MediaJobKind } from '../../types'
import { ConfirmDialog } from '../../components/ui'
import { friendlyError } from '../../utils'
import { toast } from '../../toast'

const KIND_LABELS: Record<MediaJobKind, string> = {
  image: '图像生成',
  video: '视频生成',
  tts: '文字转语音',
  classify: '分类',
  asr: '语音转写',
}

const KIND_ORDER: MediaJobKind[] = ['image', 'video', 'tts', 'asr', 'classify']

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 媒体成本账本与资产回收：只统计最近 200 个作业。 */
export default function MediaUsageSection() {
  const [jobs, setJobs] = useState<MediaJob[]>([])
  const [loading, setLoading] = useState(true)
  const [cleaning, setCleaning] = useState(false)
  const [confirmGc, setConfirmGc] = useState(false)

  const load = useCallback(async () => {
    try {
      setJobs(await mediaApi.list(200))
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const runGc = async () => {
    setCleaning(true)
    try {
      const report = await mediaApi.gcAssets(30)
      toast(`已回收 ${report.removed} 个资产，释放 ${formatBytes(report.freedBytes)}`)
      await load()
    } catch (error) {
      toast(friendlyError(error))
    } finally {
      setCleaning(false)
      setConfirmGc(false)
    }
  }

  const succeeded = jobs.filter((job) => job.status === 'succeeded')
  const totalCost = succeeded.reduce((sum, job) => sum + (job.costUsd ?? 0), 0)
  const totals = KIND_ORDER.map((kind) => {
    const rows = succeeded.filter((job) => job.kind === kind)
    return {
      kind,
      count: rows.length,
      cost: rows.reduce((sum, job) => sum + (job.costUsd ?? 0), 0),
    }
  }).filter((item) => item.count > 0)

  return (
    <>
      <div className="settings-section-title">媒体存储与成本</div>
      <div className="form-field">
        <span className="form-label">最近 200 个成功作业 · 合计 ${totalCost.toFixed(4)}</span>
        <p className="settings-note">
          成本按模型设置里的单价换算（每张 / 每秒 / 每千字符 / 每分钟）；未配置价格时不产生金额。
        </p>
        {loading ? (
          <p className="settings-note">加载中…</p>
        ) : totals.length === 0 ? (
          <p className="settings-note">还没有成功生成的媒体作业。</p>
        ) : (
          totals.map((item) => (
            <div key={item.kind} className="skill-row">
              <div className="skill-info">
                <span className="skill-name">{KIND_LABELS[item.kind]}</span>
                <span className="skill-desc">
                  {item.count} 次 · ${item.cost.toFixed(4)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="form-field">
        <span className="form-label">清理未引用媒体</span>
        <p className="settings-note">
          保留笔记正文引用的文件、聊天附图与 30 天内生成的产物；其余文件会被删除，操作不可撤销。
        </p>
        <button
          type="button"
          className="restore-default"
          disabled={cleaning}
          onClick={() => setConfirmGc(true)}
        >
          {cleaning ? '正在清理…' : '清理未引用媒体'}
        </button>
      </div>

      {confirmGc && (
        <ConfirmDialog
          title="清理未引用媒体"
          message="将删除未被笔记、聊天记录或 30 天内作业引用的媒体文件，且不可恢复。确定继续吗？"
          confirmText="清理"
          danger
          onConfirm={() => void runGc()}
          onCancel={() => setConfirmGc(false)}
        />
      )}
    </>
  )
}
