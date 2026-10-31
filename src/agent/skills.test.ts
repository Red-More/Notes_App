import { describe, expect, it } from 'vitest'
import { buildSkillsIndex, parseTriggerInput } from './skills'
import type { SkillSummary } from '../types'

function skill(partial: Partial<SkillSummary> & Pick<SkillSummary, 'id' | 'name'>): SkillSummary {
  return {
    id: partial.id,
    name: partial.name,
    description: partial.description ?? '测试技能',
    triggers: partial.triggers ?? [],
    scope: partial.scope ?? 'chat',
    version: partial.version ?? '1.0',
    enabled: partial.enabled ?? true,
    builtin: partial.builtin ?? false,
  }
}

describe('skills index', () => {
  it('injects only enabled metadata into the prompt index', () => {
    const index = buildSkillsIndex([
      skill({ id: 'daily-review', name: '每日复盘', triggers: ['复盘今天'], builtin: true }),
      skill({ id: 'off', name: '停用技能', enabled: false, triggers: ['停用触发'] }),
    ])
    expect(index).toContain('每日复盘')
    expect(index).toContain('daily-review')
    expect(index).toContain('复盘今天')
    expect(index).not.toContain('停用技能')
    expect(index).not.toContain('停用触发')
  })

  it('returns an empty index when nothing is enabled', () => {
    expect(buildSkillsIndex([skill({ id: 'off', name: '停用', enabled: false })])).toBe('')
  })
})

describe('trigger input', () => {
  it('splits mixed separators and ignores empty entries', () => {
    const result = parseTriggerInput('复盘今天, 今天总结，日复盘、')
    expect(result.triggers).toEqual(['复盘今天', '今天总结', '日复盘'])
    expect(result.issues.some((issue) => issue.message.includes('空触发词'))).toBe(true)
  })

  it('collapses whitespace and splits pasted lines', () => {
    const result = parseTriggerInput('a   b\nc d')
    expect(result.triggers).toEqual(['a b', 'c d'])
  })

  it('dedupes case-insensitively and reports it', () => {
    const result = parseTriggerInput('RUST, rust, 复盘')
    expect(result.triggers).toEqual(['RUST', '复盘'])
    expect(result.issues.some((issue) => issue.message.includes('已自动去重'))).toBe(true)
  })

  it('blocks more than ten triggers', () => {
    const raw = Array.from({ length: 11 }, (_, index) => `触发${index}`).join(',')
    const result = parseTriggerInput(raw)
    expect(result.triggers).toHaveLength(11)
    expect(result.issues.some((issue) => issue.level === 'error')).toBe(true)
  })

  it('blocks triggers longer than 40 characters', () => {
    const result = parseTriggerInput('长'.repeat(41))
    expect(result.triggers).toEqual([])
    expect(result.issues.some((issue) => issue.level === 'error')).toBe(true)
  })

  it('warns but allows an empty trigger list', () => {
    const result = parseTriggerInput('   ')
    expect(result.triggers).toEqual([])
    expect(result.issues[0]).toMatchObject({ level: 'warning' })
  })
})
