// Prompt settings: shows the exact system prompt sent to models and lets the
// user replace it. Tool descriptions stay read-only because rewriting them
// would break tool-call contracts.
import { useMemo, useState } from 'react'
import {
  buildSystemPrompt,
  clearPromptOverride,
  defaultSystemPrompt,
  hasPromptOverride,
  savePromptOverride,
} from '../../agent/prompt'
import { createTools } from '../../agent/tools'
import { toast } from '../../toast'

export default function PromptSection() {
  const [custom, setCustom] = useState(() => hasPromptOverride())
  const [draft, setDraft] = useState(() => buildSystemPrompt())

  const tools = useMemo(
    () =>
      createTools().map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
      })),
    [],
  )

  const save = () => {
    const text = draft.trim()
    if (text === '') {
      toast('提示词不能为空')
      return
    }
    if (text === defaultSystemPrompt().trim()) {
      // Keep the built-in prompt as the source of truth when nothing changed,
      // so later default updates still reach the model.
      clearPromptOverride()
      setCustom(false)
      toast('已恢复默认提示词')
      return
    }
    savePromptOverride(text)
    setCustom(true)
    toast('提示词已保存，新对话生效')
  }

  const reset = () => {
    clearPromptOverride()
    setCustom(false)
    setDraft(defaultSystemPrompt())
    toast('已恢复默认提示词')
  }

  return (
    <>
      <div className="settings-section-title">提示词设定</div>
      <p className="settings-note">
        下面是实际发送给模型的系统提示词原文。自定义后会完全取代默认设定，
        技能索引与当前日期不再自动拼接；工具提示词由程序生成，只读展示。
      </p>

      <div className="form-field">
        <span className="form-label">系统提示词{custom ? '（自定义）' : '（默认）'}</span>
        <textarea
          className="form-input param-json"
          rows={12}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </div>

      <div className="param-row">
        <button type="button" className="restore-default" onClick={save}>
          保存自定义
        </button>
        <button type="button" className="restore-default" onClick={reset} disabled={!custom}>
          恢复默认
        </button>
      </div>

      <div className="form-field">
        <span className="form-label">工具提示词（只读）</span>
        <div className="settings-note">
          {tools.map((tool) => (
            <div key={tool.name} className="prompt-tool-row">
              <strong>{tool.name}</strong> · {tool.label}
              <div>{tool.description}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  )
}
