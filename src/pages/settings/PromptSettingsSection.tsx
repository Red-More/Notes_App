import { useEffect, useMemo, useState } from 'react'
import { chatApi, skillApi } from '../../api'
import type { AgentSettings, SkillSummary } from '../../types'
import { toast } from '../../toast'
import { friendlyError } from '../../utils'
import { IconTrash } from '../../components/Icons'
import { buildSkillsIndex } from '../../agent/skills'
import {
  composeSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  MAX_SYSTEM_PROMPT_BYTES,
} from '../../agent/prompt'

/** UTF-8 byte counter shared by the prompt editors. */
const TEXT_ENCODER = new TextEncoder()

/** Split stored rules into editable entries; free-form text stays one entry. */
function parseRuleItems(rules: string): string[] {
  const text = rules.trim()
  if (!text) return []
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const bulleted = lines.every((line) => /^\s*[-*]\s+/.test(line))
  if (!bulleted) return [text]
  return lines.map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
}

/** Serialize entries as a Markdown bullet list, indenting continuation lines. */
function serializeRuleItems(items: string[]): string {
  return items
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) =>
      item
        .split('\n')
        .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`))
        .join('\n'),
    )
    .join('\n')
}

/** Rules editor: itemized entries saved as a Markdown list. */
export function RulesSection() {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [items, setItems] = useState<string[]>([])
  const [initialText, setInitialText] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    chatApi
      .settings()
      .then((value) => {
        if (cancelled) return
        const parsed = parseRuleItems(value.rules)
        setSettings(value)
        setItems(parsed)
        setInitialText(serializeRuleItems(parsed))
      })
      .catch((e) => {
        if (!cancelled) toast(friendlyError(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const serialized = serializeRuleItems(items)
  const changed = serialized !== initialText

  const updateItem = (index: number, value: string) =>
    setItems((current) => current.map((item, i) => (i === index ? value : item)))

  const addItem = () => setItems((current) => [...current, ''])

  const removeItem = (index: number) =>
    setItems((current) => current.filter((_, i) => i !== index))

  const save = async () => {
    if (!settings) return
    setBusy(true)
    try {
      await chatApi.savePromptConfig({
        systemPrompt: settings.systemPrompt,
        rules: serialized,
        injectSkills: settings.injectSkills,
      })
      const next = await chatApi.settings()
      setSettings(next)
      const parsed = parseRuleItems(next.rules)
      setItems(parsed)
      setInitialText(serializeRuleItems(parsed))
      toast('规则配置已保存')
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <p className="settings-note">
        每条规则独占一条，保存时写成 Markdown 列表；条目内可使用 Markdown 行内语法。
      </p>

      {loading ? (
        <p className="settings-note">加载中…</p>
      ) : items.length === 0 ? (
        <p className="settings-note">还没有规则。添加条目后会随请求发送给模型。</p>
      ) : (
        <div className="rule-list">
          {items.map((item, index) => (
            <div className="rule-item" key={index}>
              <span className="rule-item-index" aria-hidden="true">
                {index + 1}
              </span>
              <textarea
                className="form-input rule-item-input"
                rows={2}
                value={item}
                placeholder="例如：回答优先使用中文，并给出可执行的步骤。"
                onChange={(e) => updateItem(index, e.target.value)}
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`删除规则 ${index + 1}`}
                onClick={() => removeItem(index)}
              >
                <IconTrash size={16} />
              </button>
            </div>
          ))}
        </div>
      )}

      <button type="button" className="restore-default" onClick={addItem}>
        添加规则条目
      </button>

      <div className="form-field">
        <button
          type="button"
          className="restore-default"
          disabled={busy || loading || !changed}
          onClick={() => void save()}
        >
          {busy ? '保存中…' : '保存规则配置'}
        </button>
      </div>
    </>
  )
}

/** System prompt editor with the exact composed request preview. */
export function SystemPromptSection() {
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  const [systemPromptText, setSystemPromptText] = useState('')
  const [injectSkills, setInjectSkills] = useState(false)
  const [skills, setSkills] = useState<SkillSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([chatApi.settings(), skillApi.list().catch(() => [])])
      .then(([value, list]) => {
        if (cancelled) return
        setSettings(value)
        setSystemPromptText(value.systemPrompt)
        setInjectSkills(value.injectSkills)
        setSkills(list)
      })
      .catch((e) => {
        if (!cancelled) toast(friendlyError(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const skillsIndex = useMemo(() => buildSkillsIndex(skills), [skills])
  // This preview is produced by the same composer the runtime uses upstream.
  const requestPrompt = useMemo(
    () =>
      composeSystemPrompt({
        systemPrompt: systemPromptText,
        rules: settings?.rules ?? '',
        skillsIndex,
        injectSkills,
      }),
    [systemPromptText, settings?.rules, skillsIndex, injectSkills],
  )

  const systemPromptBytes = TEXT_ENCODER.encode(systemPromptText).length
  const requestBytes = TEXT_ENCODER.encode(requestPrompt).length
  const changed = systemPromptText !== (settings?.systemPrompt ?? '')

  const save = async () => {
    if (!settings) return
    setBusy(true)
    try {
      await chatApi.savePromptConfig({
        systemPrompt: systemPromptText,
        rules: settings.rules,
        injectSkills,
      })
      const next = await chatApi.settings()
      setSettings(next)
      // Reflect the normalized values exactly as they will be sent.
      setSystemPromptText(next.systemPrompt)
      setInjectSkills(next.injectSkills)
      toast('系统提示词已保存')
    } catch (e) {
      toast(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="form-field">
        <span className="form-label">系统提示词</span>
        <textarea
          className="form-input param-json"
          rows={5}
          value={systemPromptText}
          placeholder={DEFAULT_SYSTEM_PROMPT}
          onChange={(e) => setSystemPromptText(e.target.value)}
        />
        <div className="field-counter">
          <p className="settings-note">
            逐字作为 system 消息发送；留空恢复默认句子，不做任何隐式改写。
          </p>
          <span className="counter-text">{systemPromptBytes}/32768</span>
        </div>
      </div>

      <div className="form-field">
        <span className="form-label">实际请求内容（System Message）</span>
        <textarea className="form-input param-json" rows={8} readOnly value={requestPrompt} />
        <div className="field-counter">
          <p className="settings-note">
            保存后与上行 system 消息逐字一致；工具声明单独传输。
          </p>
          <span className="counter-text">
            {requestBytes}/{MAX_SYSTEM_PROMPT_BYTES}
          </span>
        </div>
      </div>

      <div className="form-field">
        <button
          type="button"
          className="restore-default"
          disabled={
            busy ||
            loading ||
            systemPromptBytes > 32768 ||
            requestBytes > MAX_SYSTEM_PROMPT_BYTES ||
            !changed
          }
          onClick={() => void save()}
        >
          {busy ? '保存中…' : '保存系统提示词'}
        </button>
      </div>
    </>
  )
}
