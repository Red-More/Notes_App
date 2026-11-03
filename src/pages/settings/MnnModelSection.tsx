import { useEffect, useState } from 'react'
import { localMnnApi } from '../../api'
import type { EngineMetrics, LocalMnnModel, LocalMnnStatus } from '../../types'
import { toast } from '../../toast'
import { friendlyError } from '../../utils'

const PHASE_TEXT: Record<string, string> = {
  unloaded: '未加载',
  loading: '正在加载',
  ready: '已就绪',
  generating: '正在生成',
  failed: '加载失败',
}

function mb(bytes: number): string {
  return bytes > 0 ? `${Math.round(bytes / 1024 / 1024)} MB` : '—'
}

function metricsText(metrics: EngineMetrics | null): string {
  if (!metrics) return ''
  return `首字 ${metrics.firstChunkMs}ms · 输出 ${metrics.outputTokens} tok · prefill ${metrics.prefillMs}ms · ${metrics.decodeTokS.toFixed(1)} tok/s`
}

/** MNN 引擎设置：bundle 目录清单、加载/卸载、绑定为会话可选模型。 */
export default function MnnModelSection({ onModelsChanged }: { onModelsChanged?: () => void }) {
  const [status, setStatus] = useState<LocalMnnStatus | null>(null)
  const [models, setModels] = useState<LocalMnnModel[]>([])
  const [threads, setThreads] = useState(4)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    const [nextStatus, nextModels] = await Promise.all([
      localMnnApi.status(),
      localMnnApi.models(),
    ])
    setStatus(nextStatus)
    setModels(nextModels)
  }

  useEffect(() => {
    Promise.all([localMnnApi.status(), localMnnApi.models()])
      .then(([nextStatus, nextModels]) => {
        setStatus(nextStatus)
        setModels(nextModels)
      })
      .catch((e) => console.error('读取 MNN 状态失败', e))
  }, [])

  // 加载/生成期间加快轮询，空闲时降频。
  const active = status?.phase === 'loading' || status?.phase === 'generating'
  useEffect(() => {
    const timer = window.setInterval(
      () => {
        void refresh().catch(() => {})
      },
      active ? 1500 : 3000,
    )
    return () => window.clearInterval(timer)
  }, [active])

  const run = async (action: () => Promise<void>, message?: string) => {
    setBusy(true)
    try {
      await action()
      await refresh()
      if (message) toast(message)
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const activate = (model: string) =>
    run(async () => {
      await localMnnApi.activate(model)
      // Rust 侧会创建稳定条目 local_mnn 并设为当前模型。
      onModelsChanged?.()
    }, 'MNN 已设为当前会话引擎')

  const supported = status?.available ?? false

  return (
    <>
      <div className="settings-section-title">本地模型（内嵌 MNN）</div>
      <p className="settings-note">
        MNN 使用 bundle 目录（模型配置与权重），需放入应用私有目录的 models/mnn 下。 与 llama.cpp
        并存：在对话页的模型选择里切换条目即可对比两个引擎的速度。
      </p>

      {!supported && (
        <p className="settings-note">
          当前构建未包含 MNN 引擎（未启用 local-mnn feature）；bundle 仍可保留，换用启用该 feature
          的构建后即可加载。
        </p>
      )}

      {status && (
        <div className="form-field">
          <span className="form-label">运行状态</span>
          <div className="model-row active">
            <div className="model-info">
              <div className="model-title">
                {PHASE_TEXT[status.phase] ?? status.phase}
                {status.model && <span className="model-badge">{status.model}</span>}
              </div>
              <div className="model-meta">
                线程 {status.threads || threads} · 重启 {status.restarts} 次
              </div>
              {status.metrics && (
                <div className="model-meta">{metricsText(status.metrics)}</div>
              )}
            </div>
            <div className="model-actions">
              <button
                type="button"
                className="restore-default"
                disabled={busy || !supported}
                onClick={() => void run(() => localMnnApi.unload(), 'MNN 已卸载')}
              >
                卸载
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="form-field">
        <span className="form-label">Bundle 目录</span>
        {models.length === 0 && (
          <p className="settings-note">
            models/mnn 下没有 bundle。请先通过开发流程或文件管理放入一个 MNN 转换后的模型目录。
          </p>
        )}
        {models.map((model) => (
          <div
            key={model.name}
            className={`model-row ${status?.model === model.name ? 'active' : ''}`}
          >
            <div className="model-info">
              <div className="model-title">{model.name}</div>
              <div className="model-meta">{mb(model.bytes)}</div>
            </div>
            <div className="model-actions">
              <button
                type="button"
                className="restore-default"
                disabled={busy || !supported}
                onClick={() => void run(() => localMnnApi.load(model.name, threads), 'MNN 已加载')}
              >
                加载
              </button>
              <button
                type="button"
                className="restore-default"
                disabled={busy || !supported}
                onClick={() => void activate(model.name)}
              >
                设为当前
              </button>
            </div>
          </div>
        ))}
        <div className="param-row">
          <span className="param-label">线程</span>
          <input
            className="param-number wide"
            type="number"
            min={1}
            max={8}
            value={threads}
            onChange={(e) => setThreads(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
          />
        </div>
      </div>
    </>
  )
}
