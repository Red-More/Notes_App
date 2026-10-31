import { useEffect, useState } from 'react'
import { chatApi } from '../../api'
import type {
  AgentModelInfo,
  AgentSettings,
  LlmParams,
  ModelApiFormat,
  ModelKind,
} from '../../types'
import { toast } from '../../toast'
import { friendlyError } from '../../utils'
import { ConfirmDialog, Modal } from '../../components/ui'
import ChipRow from '../../components/ChipRow'

const FORMAT_OPTIONS: Array<{ key: ModelApiFormat; label: string }> = [
  { key: 'openai-chat', label: 'OpenAI Chat Completions' },
  { key: 'openai-responses', label: 'OpenAI Responses API' },
  { key: 'anthropic-messages', label: 'Anthropic Messages' },
  { key: 'openai-images', label: 'OpenAI Images' },
  { key: 'openai-audio', label: 'OpenAI Audio' },
  { key: 'openai-videos', label: 'OpenAI Videos' },
  { key: 'openai-transcriptions', label: 'OpenAI Transcriptions' },
]

const CHAT_FORMATS: ModelApiFormat[] = ['openai-chat', 'openai-responses', 'anthropic-messages']

/** Only formats the selected capability can actually execute today. */
function formatOptionsFor(kind: ModelKind): Array<{ key: ModelApiFormat; label: string }> {
  const allowed =
    kind === 'image'
      ? ['openai-images']
      : kind === 'tts'
        ? ['openai-audio']
        : kind === 'video'
          ? ['openai-videos']
          : kind === 'asr'
            ? ['openai-transcriptions']
            : CHAT_FORMATS
  return FORMAT_OPTIONS.filter((item) => allowed.includes(item.key))
}

/** Capability groups shown in the model list; only chat runs today. */
const KIND_OPTIONS: Array<{ key: ModelKind; label: string }> = [
  { key: 'chat', label: '对话模型' },
  { key: 'image', label: '图像生成' },
  { key: 'video', label: '视频生成' },
  { key: 'tts', label: '文字转语音' },
  { key: 'classify', label: '分类模型' },
  { key: 'asr', label: '语音转写' },
]

const KIND_ORDER: ModelKind[] = KIND_OPTIONS.map((item) => item.key)

function kindLabel(kind: ModelKind): string {
  return KIND_OPTIONS.find((item) => item.key === kind)?.label ?? kind
}

/** Condensed capability hint for one model row. */
function capabilityLabel(entry: AgentModelInfo): string {
  const window = entry.contextWindowInput
    ? entry.contextWindowInput >= 1000000
      ? `上下文 ${entry.contextWindowInput / 1000000}M`
      : `上下文 ${Math.round(entry.contextWindowInput / 1000)}k`
    : '上下文未声明'
  return `${window} · ${entry.supportsImages ? '图片输入' : '纯文本'}`
}

/** Base URL suggestions only; the app never ships preset models. */
const URL_PRESETS: Array<{ label: string; baseUrl: string; format: ModelApiFormat }> = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', format: 'openai-chat' },
  {
    label: '火山引擎（豆包）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    format: 'openai-chat',
  },
  {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    format: 'openai-chat',
  },
  { label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', format: 'openai-chat' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', format: 'openai-chat' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', format: 'openai-chat' },
  {
    label: 'OpenAI（Chat Completions）',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai-chat',
  },
  {
    label: 'OpenAI（Responses）',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai-responses',
  },
  {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    format: 'anthropic-messages',
  },
  {
    label: 'OpenAI（Images）',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai-images',
  },
  {
    label: 'OpenAI（Audio）',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai-audio',
  },
  {
    label: 'OpenAI（Videos）',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai-videos',
  },
  {
    label: 'OpenAI（Transcriptions）',
    baseUrl: 'https://api.openai.com/v1',
    format: 'openai-transcriptions',
  },
]

const THINKING_OPTIONS: Array<{ key: NonNullable<LlmParams['thinkingMode']>; label: string }> = [
  { key: 'default', label: '跟随模型默认' },
  { key: 'on', label: '开启思考' },
  { key: 'off', label: '关闭思考' },
]

const IMAGE_OPTIONS = [
  { key: 'no', label: '不支持' },
  { key: 'yes', label: '支持' },
]

const INPUT_WINDOW_CHIPS = [128000, 256000, 512000, 1000000]
const OUTPUT_WINDOW_CHIPS = [4000, 8000, 16000, 32768]

/** Tool rounds stay local: they limit the agent loop and are never sent as a
 * provider parameter. 500 matches the previous runtime ceiling. */
const DEFAULT_TOOL_ROUNDS = 500

interface Draft {
  id: string
  label: string
  format: ModelApiFormat
  kind: ModelKind
  baseUrl: string
  modelId: string
  fullUrl: boolean
  apiKey: string
  showKey: boolean
  params: LlmParams
  extraText: string
  advancedOpen: boolean
  models: string[]
  modelsLoading: boolean
  modelsError: string
}

function emptyDraft(): Draft {
  return {
    id: '',
    label: '',
    format: 'openai-chat',
    kind: 'chat',
    baseUrl: '',
    modelId: '',
    fullUrl: false,
    apiKey: '',
    showKey: false,
    params: { toolRounds: DEFAULT_TOOL_ROUNDS },
    extraText: '',
    advancedOpen: false,
    models: [],
    modelsLoading: false,
    modelsError: '',
  }
}

function formatLabel(format: ModelApiFormat): string {
  return FORMAT_OPTIONS.find((item) => item.key === format)?.label ?? format
}

function endpointHint(format: ModelApiFormat, fullUrl: boolean): string {
  if (fullUrl) {
    switch (format) {
      case 'openai-responses':
        return '直接使用该完整地址，不再拼接路径；请确保地址包含 /v1/responses。'
      case 'anthropic-messages':
        return '直接使用该完整地址，不再拼接路径（示例 https://api.anthropic.com/v1/messages）。'
      case 'openai-images':
        return '直接使用该完整地址，不再拼接路径（示例 https://api.openai.com/v1/images/generations）。'
      case 'openai-audio':
        return '直接使用该完整地址，不再拼接路径（示例 https://api.openai.com/v1/audio/speech）。'
      case 'openai-videos':
        return '直接使用该完整地址，不再拼接路径（示例 https://api.openai.com/v1/videos）。'
      case 'openai-transcriptions':
        return '直接使用该完整地址，不再拼接路径（示例 https://api.openai.com/v1/audio/transcriptions）。'
      default:
        return '直接使用该完整地址，不再拼接路径（示例 https://api.openai.com/v1/chat/completions）。'
    }
  }
  switch (format) {
    case 'openai-responses':
      return '不要以 / 结尾；系统会拼接 /responses。'
    case 'anthropic-messages':
      return '不要以 / 结尾；系统会拼接 /v1/messages。'
    case 'openai-images':
      return '不要以 / 结尾；系统会拼接 /images/generations。'
    case 'openai-audio':
      return '不要以 / 结尾；系统会拼接 /audio/speech。'
    case 'openai-videos':
      return '不要以 / 结尾；系统会拼接 /videos，并轮询任务状态。'
    case 'openai-transcriptions':
      return '不要以 / 结尾；系统会拼接 /audio/transcriptions（multipart 上传）。'
    default:
      return '不要以 / 结尾；系统会拼接 /chat/completions。'
  }
}

function endpointPlaceholder(format: ModelApiFormat, fullUrl: boolean): string {
  if (fullUrl) {
    switch (format) {
      case 'openai-responses':
        return 'https://api.openai.com/v1/responses'
      case 'anthropic-messages':
        return 'https://api.anthropic.com/v1/messages'
      case 'openai-images':
        return 'https://api.openai.com/v1/images/generations'
      case 'openai-audio':
        return 'https://api.openai.com/v1/audio/speech'
      case 'openai-videos':
        return 'https://api.openai.com/v1/videos'
      case 'openai-transcriptions':
        return 'https://api.openai.com/v1/audio/transcriptions'
      default:
        return 'https://api.openai.com/v1/chat/completions'
    }
  }
  return format === 'anthropic-messages'
    ? 'https://api.anthropic.com'
    : 'https://api.openai.com/v1'
}

function parseJsonObject(text: string, field: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return {}
  try {
    const value = JSON.parse(trimmed)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // fall through to the user-facing error below
  }
  toast(`${field} 必须是 JSON 对象`)
  return null
}

function NumberField(props: {
  label: string
  value: number | undefined
  min: number
  max: number
  placeholder?: string
  onChange: (value: number | undefined) => void
}) {
  return (
    <div className="param-row">
      <span className="param-label">{props.label}</span>
      <input
        className="param-number wide"
        type="number"
        min={props.min}
        max={props.max}
        value={props.value ?? ''}
        placeholder={props.placeholder ?? '留空使用厂商默认'}
        onChange={(e) =>
          props.onChange(e.target.value.trim() === '' ? undefined : Number(e.target.value))
        }
      />
    </div>
  )
}

function WindowChips(props: {
  values: number[]
  current: number | undefined
  onPick: (value: number) => void
}) {
  const label = (value: number) =>
    value >= 1000000 ? `${value / 1000000}M` : value >= 1000 ? `${value / 1000}k` : `${value}`
  return (
    <div className="param-chips">
      {props.values.map((value) => (
        <button
          key={value}
          type="button"
          className={`chip-btn ${props.current === value ? 'active' : ''}`}
          onClick={() => props.onPick(value)}
        >
          {label(value)}
        </button>
      ))}
    </div>
  )
}

function ParamsEditor(props: {
  draft: Draft
  patchParams: (patch: Partial<LlmParams>) => void
  patchDraft: (patch: Partial<Draft>) => void
}) {
  const { draft, patchParams, patchDraft } = props
  const params = draft.params
  return (
    <>
      <div className="form-field">
        <span className="form-label">上下文窗口（Token）</span>
        <div className="param-row">
          <span className="param-label">输入</span>
          <input
            className="param-number wide"
            type="number"
            min={256}
            max={1000000}
            value={params.contextWindowInput ?? ''}
            placeholder="留空使用模型默认"
            onChange={(e) =>
              patchParams({
                contextWindowInput:
                  e.target.value.trim() === '' ? undefined : Number(e.target.value),
              })
            }
          />
          <WindowChips
            values={INPUT_WINDOW_CHIPS}
            current={params.contextWindowInput}
            onPick={(contextWindowInput) => patchParams({ contextWindowInput })}
          />
        </div>
        <div className="param-row">
          <span className="param-label">输出</span>
          <input
            className="param-number wide"
            type="number"
            min={1}
            max={32768}
            value={params.contextWindowOutput ?? ''}
            placeholder={
              draft.format === 'anthropic-messages'
                ? '留空按协议兜底 4096'
                : '留空使用模型默认'
            }
            onChange={(e) =>
              patchParams({
                contextWindowOutput:
                  e.target.value.trim() === '' ? undefined : Number(e.target.value),
              })
            }
          />
          <WindowChips
            values={OUTPUT_WINDOW_CHIPS}
            current={params.contextWindowOutput}
            onPick={(contextWindowOutput) => patchParams({ contextWindowOutput })}
          />
        </div>
        {draft.format === 'anthropic-messages' && (
          <p className="settings-note">
            Anthropic 协议要求 max_tokens；输出留空时按协议兜底 4096，这不是模型默认值。
          </p>
        )}
      </div>

      <div className="form-field">
        <NumberField
          label="工具调用轮次"
          value={params.toolRounds}
          min={1}
          max={500}
          placeholder={`默认 ${DEFAULT_TOOL_ROUNDS}`}
          onChange={(toolRounds) => patchParams({ toolRounds })}
        />
        <p className="settings-note">
          单轮对话中工具调用的最大往返次数，仅用于本地限制，不会发送给厂商。
        </p>
      </div>

      <div className="form-field">
        <span className="form-label">图片输入支持</span>
        <ChipRow
          items={IMAGE_OPTIONS}
          value={params.supportsImages ? 'yes' : 'no'}
          onChange={(key) => patchParams({ supportsImages: key === 'yes' })}
        />
      </div>

      <div className="form-field">
        <span className="form-label">思考模式</span>
        <ChipRow
          items={THINKING_OPTIONS}
          value={params.thinkingMode ?? 'default'}
          onChange={(thinkingMode) => patchParams({ thinkingMode })}
        />
      </div>

      <div className="form-field">
        <span className="form-label">价格（USD，可选）</span>
        {(draft.kind === 'chat' || draft.kind === 'classify') && (
          <>
            <NumberField
              label="输入 / 百万 token"
              value={params.inputPrice}
              min={0}
              max={1000000}
              placeholder="留空表示未配置"
              onChange={(inputPrice) => patchParams({ inputPrice })}
            />
            <NumberField
              label="输出 / 百万 token"
              value={params.outputPrice}
              min={0}
              max={1000000}
              placeholder="留空表示未配置"
              onChange={(outputPrice) => patchParams({ outputPrice })}
            />
          </>
        )}
        {draft.kind === 'image' && (
          <NumberField
            label="每张图片"
            value={params.imagePrice}
            min={0}
            max={1000000}
            placeholder="留空表示未配置"
            onChange={(imagePrice) => patchParams({ imagePrice })}
          />
        )}
        {draft.kind === 'video' && (
          <NumberField
            label="每秒视频"
            value={params.videoSecondPrice}
            min={0}
            max={1000000}
            placeholder="留空表示未配置"
            onChange={(videoSecondPrice) => patchParams({ videoSecondPrice })}
          />
        )}
        {draft.kind === 'tts' && (
          <NumberField
            label="每千字符"
            value={params.ttsKcharPrice}
            min={0}
            max={1000000}
            placeholder="留空表示未配置"
            onChange={(ttsKcharPrice) => patchParams({ ttsKcharPrice })}
          />
        )}
        {draft.kind === 'asr' && (
          <NumberField
            label="每分钟音频"
            value={params.asrMinutePrice}
            min={0}
            max={1000000}
            placeholder="留空表示未配置"
            onChange={(asrMinutePrice) => patchParams({ asrMinutePrice })}
          />
        )}
        <p className="settings-note">价格只用于成本统计，不会写入请求体。</p>
      </div>

      <div className="form-field">
        <span className="form-label">超参数</span>
        <NumberField
          label="Temperature"
          value={params.temperature}
          min={0}
          max={2}
          placeholder="留空使用厂商默认（0–2）"
          onChange={(temperature) => patchParams({ temperature })}
        />
        <NumberField
          label="Top P"
          value={params.topP}
          min={0}
          max={1}
          placeholder="留空使用厂商默认（0–1）"
          onChange={(topP) => patchParams({ topP })}
        />
        <NumberField
          label="Top K"
          value={params.topK}
          min={1}
          max={1000}
          placeholder="留空使用厂商默认（1–1000）"
          onChange={(topK) => patchParams({ topK })}
        />
        <p className="settings-note">
          高级设置留空时不会写入请求体，参数由服务端/厂商自行决定默认值。
        </p>
      </div>

      <div className="form-field">
        <span className="form-label">请求透传（extra，可选）</span>
        <textarea
          className="form-input param-json"
          rows={3}
          value={draft.extraText}
          placeholder='例如 {"custom_flag": true}'
          onChange={(e) => patchDraft({ extraText: e.target.value })}
        />
        <p className="settings-note">
          原样并入请求体顶层；不能覆盖 model / input / messages / tools / stream 等保留字段。
        </p>
      </div>
    </>
  )
}

export default function AgentSettingsSection() {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<AgentModelInfo | null>(null)

  const refresh = async () => setSettings(await chatApi.settings())

  useEffect(() => {
    chatApi
      .settings()
      .then((value) => setSettings(value))
      .catch((e) => console.error('读取模型列表失败', e))
  }, [])

  const patchDraft = (patch: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current))
  const patchParams = (patch: Partial<LlmParams>) =>
    setDraft((current) =>
      current ? { ...current, params: { ...current.params, ...patch } } : current,
    )

  const openCreate = () => setDraft(emptyDraft())

  const openEdit = async (entry: AgentModelInfo) => {
    setBusy(true)
    try {
      const params = await chatApi.paramsGet(entry.id)
      setDraft({
        id: entry.id,
        label: entry.label,
        format: entry.format,
        kind: entry.kind,
        baseUrl: entry.baseUrl,
        modelId: entry.modelId,
        fullUrl: entry.fullUrl,
        apiKey: '',
        showKey: false,
        params: { ...params, toolRounds: params.toolRounds ?? DEFAULT_TOOL_ROUNDS },
        extraText: params.extra ? JSON.stringify(params.extra, null, 2) : '',
        advancedOpen: false,
        models: [],
        modelsLoading: false,
        modelsError: '',
      })
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const resetDraft = () => {
    if (!draft) return
    if (draft.id) {
      const entry = settings?.models.find((item) => item.id === draft.id)
      if (entry) void openEdit(entry)
      return
    }
    setDraft(emptyDraft())
  }

  const fetchModels = async () => {
    if (!draft) return
    if (!draft.baseUrl.trim()) {
      toast('请先填写请求地址')
      return
    }
    if (draft.fullUrl) {
      toast('Full URL 模式下无法自动发现模型，请手动填写 Model ID')
      return
    }
    if (!draft.apiKey.trim() && !draft.id) {
      toast('请先填写 API Key 再拉取模型列表')
      return
    }
    patchDraft({ modelsLoading: true, modelsError: '' })
    try {
      const list = await chatApi.modelsList({
        id: draft.id || undefined,
        format: draft.format,
        baseUrl: draft.baseUrl.trim(),
        fullUrl: false,
        apiKey: draft.apiKey.trim() || undefined,
      })
      patchDraft({
        models: list,
        modelId: draft.modelId.trim() || list[0] || '',
        modelsLoading: false,
      })
      toast(`已拉取 ${list.length} 个模型`)
    } catch (e) {
      patchDraft({
        models: [],
        modelsLoading: false,
        modelsError: `拉取失败：${friendlyError(e)}；可手动填写 Model ID`,
      })
    }
  }

  const testDraft = async () => {
    if (!draft) return
    if (draft.kind !== 'chat') {
      toast('媒体与分类模型暂不支持连接测试')
      return
    }
    const modelId = draft.modelId.trim()
    if (!draft.baseUrl.trim() || !modelId) {
      toast('请先填写请求地址与 Model ID')
      return
    }
    if (!draft.apiKey.trim() && !draft.id) {
      toast('请先填写 API Key')
      return
    }
    setBusy(true)
    try {
      const result = await chatApi.testConnection({
        id: draft.id || undefined,
        format: draft.format,
        baseUrl: draft.baseUrl.trim(),
        modelId,
        fullUrl: draft.fullUrl,
        apiKey: draft.apiKey.trim() || undefined,
      })
      toast(`连接成功 · ${result.latencyMs}ms`)
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const saveDraft = async () => {
    if (!draft) return
    const modelId = draft.modelId.trim()
    if (!draft.baseUrl.trim() || !modelId) {
      toast('请填写请求地址与 Model ID')
      return
    }
    if (!draft.id && !draft.apiKey.trim()) {
      toast('API Key 必填')
      return
    }
    const existing = settings?.models.find((item) => item.id === draft.id)
    if (draft.id && existing && !existing.configured && !draft.apiKey.trim()) {
      toast('该模型尚未保存 API Key，请填写')
      return
    }
    const extra = parseJsonObject(draft.extraText, 'extra')
    if (extra === null) return
    const params: LlmParams = {
      ...draft.params,
      toolRounds: draft.params.toolRounds ?? DEFAULT_TOOL_ROUNDS,
      extra: Object.keys(extra).length > 0 ? extra : undefined,
    }
    setBusy(true)
    try {
      const saved = await chatApi.saveModel({
        id: draft.id || undefined,
        label: draft.label.trim(),
        format: draft.format,
        baseUrl: draft.baseUrl.trim(),
        modelId,
        fullUrl: draft.fullUrl,
        kind: draft.kind,
        apiKey: draft.apiKey.trim() || undefined,
      })
      await chatApi.paramsSet(saved.id, params)
      await refresh()
      setDraft(null)
      toast(draft.id ? '模型已保存' : '模型已添加')
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const activate = async (entry: AgentModelInfo) => {
    setBusy(true)
    try {
      await chatApi.activateModel(entry.id)
      await refresh()
      toast(`已切换到 ${entry.label}`)
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const testSaved = async (entry: AgentModelInfo) => {
    if (entry.kind !== 'chat') {
      toast('媒体与分类模型暂不支持连接测试')
      return
    }
    setBusy(true)
    try {
      const result = await chatApi.testConnection({
        id: entry.id,
        format: entry.format,
        baseUrl: entry.baseUrl,
        modelId: entry.modelId,
        fullUrl: entry.fullUrl,
      })
      toast(`${entry.label} 连接成功 · ${result.latencyMs}ms`)
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const removeModel = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await chatApi.deleteModel(deleteTarget.id)
      await refresh()
      toast(`${deleteTarget.label} 已删除`)
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
      setDeleteTarget(null)
    }
  }

  const editing = draft?.id !== '' && draft != null
  const matchedPreset = draft
    ? URL_PRESETS.find(
        (item) => item.baseUrl === draft.baseUrl && item.format === draft.format,
      )
    : undefined

  return (
    <>
      <div className="settings-section-title">AI 助理</div>
      <p className="settings-note">
        模型列表（Model List）：系统不提供预置模型，所有模型均由你添加；添加前需填写 API Key。
      </p>
      <div className="form-field">
        <button type="button" className="btn btn-primary model-add" onClick={openCreate}>
          添加模型（Model Add）
        </button>
      </div>

      {settings && settings.models.length === 0 && (
        <p className="settings-note">
          列表为空。添加对话模型后即可开始聊天；图像/视频/语音/分类模型可先添加，接入后启用。
        </p>
      )}

      {KIND_ORDER.map((kind) => {
        const group = settings?.models.filter((entry) => entry.kind === kind) ?? []
        if (group.length === 0) return null
        return (
          <div key={kind} className="model-group">
            <div className="model-group-title">{kindLabel(kind)}</div>
            {group.map((entry) => {
              const active = kind === 'chat' && settings?.activeId === entry.id
              return (
                <div key={entry.id} className={`model-row ${active ? 'active' : ''}`}>
                  <div className="model-info">
                    <div className="model-title">
                      {entry.label}
                      {active && <span className="model-badge">使用中</span>}
                      {kind !== 'chat' && <span className="model-badge">可用</span>}
                    </div>
                    <div className="model-meta">
                      {entry.modelId} · {formatLabel(entry.format)}
                    </div>
                    <div className="model-meta">{capabilityLabel(entry)}</div>
                    <div className="model-meta">
                      {entry.fullUrl ? '完整地址' : 'Base URL'} · {entry.baseUrl}
                    </div>
                    <div className="model-meta">
                      {entry.configured ? '已配置 API Key' : '未配置 API Key'}
                    </div>
                  </div>
                  <div className="model-actions">
                    <button
                      type="button"
                      className="restore-default"
                      disabled={busy || active || kind !== 'chat'}
                      onClick={() => void activate(entry)}
                    >
                      使用
                    </button>
                    <button
                      type="button"
                      className="restore-default"
                      disabled={busy || kind !== 'chat'}
                      onClick={() => void testSaved(entry)}
                    >
                      测试
                    </button>
                    <button
                      type="button"
                      className="restore-default"
                      disabled={busy}
                      onClick={() => void openEdit(entry)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="restore-default danger"
                      disabled={busy}
                      onClick={() => setDeleteTarget(entry)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}

      {draft && (
        <Modal
          title={editing ? '编辑模型' : '添加模型'}
          onClose={() => setDraft(null)}
          footer={
            <div style={{ display: 'flex', gap: 10 }}>
              <button type="button" className="btn btn-plain" disabled={busy} onClick={resetDraft}>
                重置
              </button>
              <button
                type="button"
                className="btn btn-plain"
                disabled={busy || draft.kind !== 'chat'}
                onClick={() => void testDraft()}
              >
                测试连接
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void saveDraft()}
              >
                {editing ? '保存' : '添加模型'}
              </button>
            </div>
          }
        >
          <div className="form-field">
            <span className="form-label">API Format</span>
            <select
              className="form-input"
              value={draft.format}
              onChange={(e) => patchDraft({ format: e.target.value as ModelApiFormat })}
            >
              {formatOptionsFor(draft.kind).map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <span className="form-label">模型能力（Model Kind）</span>
            <select
              className="form-input"
              value={draft.kind}
              onChange={(e) => {
                const kind = e.target.value as ModelKind
                patchDraft({
                  kind,
                  format: formatOptionsFor(kind)[0].key,
                  models: [],
                  modelsError: '',
                })
              }}
            >
              {KIND_OPTIONS.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
            {draft.kind !== 'chat' && (
              <p className="settings-note">
                {draft.kind === 'video'
                  ? '视频使用 OpenAI Videos 兼容协议：提交后轮询任务，完成后下载到资产库。'
                  : draft.kind === 'asr'
                    ? '语音转写使用 OpenAI Transcriptions 兼容协议：上传音频后返回文本。'
                    : '该能力已可执行：图像走 Images 协议，语音走 Audio 协议，分类走 Chat 协议。'}
              </p>
            )}
          </div>

          <div className="form-field">
            <span className="form-label">预设请求地址（可选）</span>
            <select
              className="form-input"
              value={matchedPreset?.label ?? ''}
              onChange={(e) => {
                const preset = URL_PRESETS.find((item) => item.label === e.target.value)
                if (preset) {
                  patchDraft({
                    baseUrl: preset.baseUrl,
                    format: preset.format,
                    fullUrl: false,
                    models: [],
                    modelsError: '',
                  })
                }
              }}
            >
              <option value="">手动输入</option>
              {URL_PRESETS.map((item) => (
                <option key={item.label} value={item.label}>
                  {item.label} · {item.baseUrl}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <span className="form-label">
              Custom Request URL
              <span className="form-required"> *</span>
            </span>
            <label className="settings-switch-row compact function-toggle">
              <input
                type="checkbox"
                checked={draft.fullUrl}
                onChange={(e) => patchDraft({ fullUrl: e.target.checked })}
              />
              <span className="settings-switch-desc">Full URL</span>
            </label>
            <input
              className="form-input"
              value={draft.baseUrl}
              onChange={(e) => patchDraft({ baseUrl: e.target.value, models: [] })}
              placeholder={endpointPlaceholder(draft.format, draft.fullUrl)}
              autoComplete="off"
            />
            <p className="settings-note">{endpointHint(draft.format, draft.fullUrl)}</p>
          </div>

          <div className="form-field">
            <span className="form-label">
              Model ID
              <span className="form-required"> *</span>
            </span>
            <div className="chat-key-actions">
              <input
                className="form-input"
                value={draft.modelId}
                onChange={(e) => patchDraft({ modelId: e.target.value })}
                placeholder="Input Model ID"
                autoComplete="off"
              />
              <button
                type="button"
                className="restore-default"
                disabled={draft.modelsLoading}
                onClick={() => void fetchModels()}
              >
                {draft.modelsLoading ? '拉取中…' : '获取模型列表'}
              </button>
            </div>
            {draft.models.length > 0 && (
              <select
                className="form-input"
                value={draft.models.includes(draft.modelId) ? draft.modelId : ''}
                onChange={(e) => patchDraft({ modelId: e.target.value })}
              >
                <option value="">从列表选择</option>
                {draft.models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            )}
            {draft.modelsError && <p className="settings-note param-error">{draft.modelsError}</p>}
          </div>

          <div className="form-field">
            <span className="form-label">Display Name（选填，留空显示 Model ID）</span>
            <div className="field-counter">
              <input
                className="form-input"
                value={draft.label}
                maxLength={64}
                onChange={(e) => patchDraft({ label: e.target.value })}
                placeholder="Input Display Name"
                autoComplete="off"
              />
              <span className="counter-text">{draft.label.length}/64</span>
            </div>
          </div>

          <div className="form-field">
            <span className="form-label">
              API Key
              {!editing && <span className="form-required"> *</span>}
            </span>
            <div className="chat-key-actions">
              <input
                className="form-input"
                type={draft.showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(e) => patchDraft({ apiKey: e.target.value })}
                placeholder={editing ? '已保存；留空保持不变' : 'Enter API Key'}
                autoComplete="off"
              />
              <button
                type="button"
                className="restore-default"
                onClick={() => patchDraft({ showKey: !draft.showKey })}
              >
                {draft.showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>

          <button
            type="button"
            className="restore-default"
            onClick={() => patchDraft({ advancedOpen: !draft.advancedOpen })}
          >
            {draft.advancedOpen ? '收起高级设置' : '高级设置'}
          </button>
          {draft.advancedOpen && (
            <ParamsEditor draft={draft} patchParams={patchParams} patchDraft={patchDraft} />
          )}
          <p className="settings-note">
            保存前可先「测试连接」；测试会发送一次真实请求（max_tokens=1），消耗极少量 token。
          </p>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="删除模型"
          message={`确定删除「${deleteTarget.label}」？其 API Key 与参数会一并清除。`}
          confirmText="删除"
          danger
          onConfirm={() => void removeModel()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  )
}
