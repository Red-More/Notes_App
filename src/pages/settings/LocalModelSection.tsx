import { useEffect, useState } from 'react'
import { open } from '@tauri-apps/plugin-dialog'
import { localApi } from '../../api'
import type { LocalModelConfig, LocalModelSnapshot } from '../../types'
import { toast } from '../../toast'
import { friendlyError } from '../../utils'
import { ConfirmDialog } from '../../components/ui'

const STATE_TEXT: Record<string, string> = {
  unsupported: '当前构建未启用',
  unloaded: '未加载',
  loading: '正在加载',
  ready: '已就绪',
  generating: '正在生成',
  suspended: '已暂停',
  failed: '加载失败',
}

function mb(bytes: number | null | undefined): string {
  if (!bytes) return '—'
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

function tierText(tier: string): string {
  switch (tier) {
    case 'none':
      return '不推荐本地模型'
    case 'low':
      return '低配（4–6GB）'
    case 'medium':
      return '中配（6–8GB）'
    case 'high':
      return '高配（≥8GB）'
    default:
      return '未知设备'
  }
}

export default function LocalModelSection() {
  const [snapshot, setSnapshot] = useState<LocalModelSnapshot | null>(null)
  const [config, setConfig] = useState<LocalModelConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  const refresh = async () => {
    const next = await localApi.status()
    setSnapshot(next)
    setConfig(next.config)
  }

  useEffect(() => {
    localApi
      .status()
      .then((next) => {
        setSnapshot(next)
        setConfig(next.config)
      })
      .catch((e) => console.error('读取本地模型状态失败', e))
  }, [])

  // Loading and generation are short transitions; poll only while active.
  const active =
    snapshot?.status.state === 'loading' || snapshot?.status.state === 'generating'
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      localApi
        .status()
        .then((next) => setSnapshot(next))
        .catch(() => {})
    }, 1500)
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

  const patchConfig = (patch: Partial<LocalModelConfig>) =>
    setConfig((current) => (current ? { ...current, ...patch } : current))

  const saveConfig = () =>
    run(async () => {
      if (!config) return
      await localApi.configSet(config)
    }, '本地模型设置已保存')

  const toggleEnabled = (enabled: boolean) => {
    if (!config) return
    const next = { ...config, enabled }
    setConfig(next)
    void run(() => localApi.configSet(next).then(() => undefined), enabled ? '已启用' : '已关闭本地模型')
  }

  const toggleKeepAlive = (keepAlive: boolean) => {
    if (!config) return
    const next = { ...config, keepAlive }
    setConfig(next)
    void run(() => localApi.configSet(next).then(() => undefined))
  }

  const importFile = async () => {
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'GGUF', extensions: ['gguf'] }],
      })
      if (typeof picked !== 'string') return
      await run(() => localApi.import(picked).then(() => undefined), '模型已导入')
    } catch (e) {
      toast(friendlyError(e))
    }
  }

  const load = () =>
    run(async () => {
      if (!config) return
      await localApi.load(config)
    }, '本地模型已加载')

  const unload = () => run(() => localApi.unload(), '本地模型已卸载')

  const activate = (file: string) =>
    run(() => localApi.activate(file), '已切换为本地对话模型')

  const remove = () => {
    if (!removeTarget) return
    const file = removeTarget
    setRemoveTarget(null)
    void run(() => localApi.remove(file), `${file} 已删除`)
  }

  const supported = snapshot?.supported ?? false
  const status = snapshot?.status
  const device = snapshot?.device
  const gate = snapshot?.gate ?? 'allow'

  return (
    <>
      <div className="settings-section-title">本地模型（内嵌 llama.cpp）</div>
      <p className="settings-note">
        模型只在本机运行，S0 敏感内容可以交给它处理且零出境。0.6B 适合总结、改写、分类与单轮问答，
        不适合多步工具编排；它不会像云端模型一样主动调用工具。
      </p>

      {!supported && (
        <p className="settings-note">
          当前构建未包含本地推理引擎（未启用 local-llm feature）；其余设置仍可保存，
          换用启用该 feature 的构建后即可加载。
        </p>
      )}

      {status && (
        <div className="form-field">
          <span className="form-label">运行状态</span>
          <div className="model-row active">
            <div className="model-info">
              <div className="model-title">
                {STATE_TEXT[status.state] ?? status.state}
                {status.model && <span className="model-badge">{status.model}</span>}
              </div>
              <div className="model-meta">
                {status.model ? `体积 ${mb(status.modelBytes)} · ` : ''}
                线程 {status.threads || device?.recommendedThreads || 0} · 上下文{' '}
                {status.contextSize || device?.recommendedContext || 0}
              </div>
              {status.error && <div className="model-meta">{status.error}</div>}
              <div className="model-meta">
                设备：{device ? tierText(device.tier) : '未知'}
                {device?.totalMemoryMb ? ` · ${device.totalMemoryMb} MB 内存` : ''}
                {device ? ` · ${device.cores} 核` : ''}
              </div>
              {device && <div className="model-meta">{device.note}</div>}
              <div className="model-meta">
                热/电量门控：{gate === 'allow' ? '允许运行' : `已暂停（${gate}）`}
                {snapshot?.power.thermalCelsius
                  ? ` · ${snapshot.power.thermalCelsius.toFixed(1)}°C`
                  : ''}
                {snapshot?.power.batteryPercent != null
                  ? ` · 电量 ${snapshot.power.batteryPercent}%`
                  : ''}
              </div>
            </div>
            <div className="model-actions">
              <button
                type="button"
                className="restore-default"
                disabled={busy || !supported}
                onClick={() => void load()}
              >
                加载
              </button>
              <button
                type="button"
                className="restore-default"
                disabled={busy}
                onClick={() => void unload()}
              >
                卸载
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="form-field">
        <span className="form-label">模型文件</span>
        {(snapshot?.files.length ?? 0) === 0 && (
          <p className="settings-note">
            目录为空。请先导入一个 GGUF 文件（例如 Qwen3-0.6B 的 IQ4_XS 或 Q8_0 量化版本）。
          </p>
        )}
        {snapshot?.files.map((file) => (
          <div key={file.name} className={`model-row ${config?.file === file.name ? 'active' : ''}`}>
            <div className="model-info">
              <div className="model-title">
                {file.name}
                {file.recommended && <span className="model-badge">推荐</span>}
              </div>
              <div className="model-meta">{mb(file.bytes)}</div>
            </div>
            <div className="model-actions">
              <button
                type="button"
                className="restore-default"
                disabled={busy || !config}
                onClick={() => config && patchConfig({ file: file.name })}
              >
                {config?.file === file.name ? '已选择' : '选择'}
              </button>
              <button
                type="button"
                className="restore-default"
                disabled={busy || !supported}
                onClick={() => void activate(file.name)}
              >
                设为当前
              </button>
              <button
                type="button"
                className="restore-default danger"
                disabled={busy}
                onClick={() => setRemoveTarget(file.name)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        <button type="button" className="restore-default" disabled={busy} onClick={() => void importFile()}>
          导入 GGUF 文件
        </button>
        <p className="settings-note">
          导入只复制到应用私有模型目录；同名文件不会覆盖。模型下载与哈希校验将在阶段 D 接入
          ModelScope。
        </p>
      </div>

      {config && (
        <>
          <div className="form-field">
            <span className="form-label">运行参数</span>
            <div className="param-row">
              <span className="param-label">线程</span>
              <input
                className="param-number wide"
                type="number"
                min={1}
                max={8}
                value={config.threads || ''}
                placeholder={`推荐 ${device?.recommendedThreads ?? 2}`}
                onChange={(e) =>
                  patchConfig({ threads: e.target.value.trim() === '' ? 0 : Number(e.target.value) })
                }
              />
            </div>
            <div className="param-row">
              <span className="param-label">上下文</span>
              <input
                className="param-number wide"
                type="number"
                min={512}
                max={8192}
                step={512}
                value={config.contextSize || ''}
                placeholder={`推荐 ${device?.recommendedContext ?? 2048}`}
                onChange={(e) =>
                  patchConfig({
                    contextSize: e.target.value.trim() === '' ? 0 : Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="param-row">
              <span className="param-label">输出上限</span>
              <input
                className="param-number wide"
                type="number"
                min={32}
                max={4096}
                value={config.maxTokens}
                onChange={(e) => patchConfig({ maxTokens: Number(e.target.value) })}
              />
            </div>
            <button
              type="button"
              className="restore-default"
              disabled={busy || !config.file}
              onClick={() => void saveConfig()}
            >
              保存参数
            </button>
            <p className="settings-note">留空的线程/上下文按设备推荐值使用；参数在下一次加载时生效。</p>
          </div>

          <div className="form-field">
            <span className="form-label">生命周期</span>
            <div className="settings-switch-row">
              <div className="settings-switch-text">
                <span className="settings-switch-title">启用本地模型</span>
                <span className="settings-switch-desc">关闭后立即释放内存，不再自动加载</span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={config.enabled}
                aria-label="启用本地模型"
                className={`settings-switch ${config.enabled ? 'on' : ''}`}
                disabled={busy || !supported}
                onClick={() => toggleEnabled(!config.enabled)}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
            <div className="settings-switch-row">
              <div className="settings-switch-text">
                <span className="settings-switch-title">允许后台常驻</span>
                <span className="settings-switch-desc">
                  默认切到后台即卸载；开启后保持加载，耗电与热压风险由用户承担
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={config.keepAlive}
                aria-label="允许后台常驻"
                className={`settings-switch ${config.keepAlive ? 'on' : ''}`}
                disabled={busy}
                onClick={() => toggleKeepAlive(!config.keepAlive)}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </div>
        </>
      )}

      {removeTarget && (
        <ConfirmDialog
          title="删除模型"
          message={`确定删除「${removeTarget}」？正在使用时需先卸载。`}
          confirmText="删除"
          danger
          onConfirm={remove}
          onCancel={() => setRemoveTarget(null)}
        />
      )}
    </>
  )
}
