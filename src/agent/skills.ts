//! 技能索引（M3）：初始 prompt 只带元数据，正文由模型通过 `load_skill` 按需加载。
//!
//! 技能永远只是 prompt 文本，不会注册工具、不会执行代码；工具面固定为
//! 5 个 fs_* + 1 个只读元工具 load_skill。

import type { SkillSummary } from '../types'

/** 触发词输入的分隔符：英文/中文逗号、顿号与换行（兼容粘贴多行）。 */
const TRIGGER_SEPARATORS = /[,，、\n]/
/** 触发词数量上限与单项长度上限，与 Rust 侧校验保持一致。 */
export const MAX_TRIGGER_COUNT = 10
export const MAX_TRIGGER_CHARS = 40

export type TriggerIssueLevel = 'info' | 'warning' | 'error'

export interface TriggerIssue {
  level: TriggerIssueLevel
  message: string
}

export interface TriggerParseResult {
  triggers: string[]
  issues: TriggerIssue[]
}

/** Trim and collapse consecutive whitespace without changing the wording. */
function normalizeTrigger(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

/**
 * Split the free-text trigger input and report normalization problems.
 * Empty input is allowed (the skill routes by description); errors block saving.
 */
export function parseTriggerInput(raw: string): TriggerParseResult {
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (text === '') {
    return {
      triggers: [],
      issues: [
        {
          level: 'warning',
          message: '未填写触发词：模型仍会按描述判断是否加载技能。',
        },
      ],
    }
  }

  const issues: TriggerIssue[] = []
  const triggers: string[] = []
  const seen = new Set<string>()
  const duplicates: string[] = []
  const tooLong: string[] = []
  let emptyCount = 0
  let hasControlChar = false

  for (const part of raw.split(TRIGGER_SEPARATORS)) {
    const value = normalizeTrigger(part)
    if (value === '') {
      emptyCount += 1
      continue
    }
    if (
      [...value].some((ch) => {
        const code = ch.codePointAt(0) ?? 0
        return code < 0x20 || code === 0x7f
      })
    ) {
      hasControlChar = true
      continue
    }
    if ([...value].length > MAX_TRIGGER_CHARS) {
      tooLong.push(value)
      continue
    }
    const key = value.toLowerCase()
    if (seen.has(key)) {
      duplicates.push(value)
      continue
    }
    seen.add(key)
    triggers.push(value)
  }

  if (emptyCount > 0) {
    issues.push({
      level: 'info',
      message: `已忽略 ${emptyCount} 个空触发词（连续或末尾分隔符）。`,
    })
  }
  if (duplicates.length > 0) {
    issues.push({
      level: 'info',
      message: `已自动去重：${duplicates.join('、')}。`,
    })
  }
  if (tooLong.length > 0) {
    const sample = [...tooLong[0]].slice(0, 20).join('')
    issues.push({
      level: 'error',
      message: `触发词「${sample}…」超过 ${MAX_TRIGGER_CHARS} 个字符。`,
    })
  }
  if (hasControlChar) {
    issues.push({
      level: 'error',
      message: '触发词包含控制字符，请删除不可见字符。',
    })
  }
  if (triggers.length > MAX_TRIGGER_COUNT) {
    issues.push({
      level: 'error',
      message: `最多 ${MAX_TRIGGER_COUNT} 个触发词，当前 ${triggers.length} 个。`,
    })
  }
  if (triggers.length === 0 && issues.every((issue) => issue.level === 'info')) {
    issues.push({
      level: 'warning',
      message: '没有有效触发词：模型仍会按描述判断是否加载技能。',
    })
  }

  return { triggers, issues }
}

/** 生成 `{{skills_index}}`：只含名称、id、描述与触发词，不含正文。 */
export function buildSkillsIndex(skills: SkillSummary[]): string {
  const enabled = skills.filter((skill) => skill.enabled)
  if (enabled.length === 0) return ''
  return enabled
    .map((skill) => {
      const triggers = skill.triggers.length > 0 ? skill.triggers.join('、') : '无'
      return `- ${skill.name}（id: ${skill.id}）：${skill.description}；触发词：${triggers}`
    })
    .join('\n')
}
