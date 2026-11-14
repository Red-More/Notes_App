//! Prompt payload transparency: composition must only use visible settings.

import { describe, expect, it } from 'vitest'
import { composeSystemPrompt, DEFAULT_SYSTEM_PROMPT } from './prompt'

const TODAY = '2026-11-14'
const DATE_BLOCK = `Today is ${TODAY}.`

describe('system prompt composition', () => {
  it('defaults to the built-in sentence followed by the runtime date', () => {
    expect(composeSystemPrompt({ today: TODAY })).toBe(
      `${DEFAULT_SYSTEM_PROMPT}\n\n${DATE_BLOCK}`,
    )
    expect(composeSystemPrompt({ systemPrompt: '   ', today: TODAY })).toBe(
      `${DEFAULT_SYSTEM_PROMPT}\n\n${DATE_BLOCK}`,
    )
  })

  it('omits rules entirely when the user configured none', () => {
    expect(composeSystemPrompt({ rules: '   ', today: TODAY })).toBe(
      `${DEFAULT_SYSTEM_PROMPT}\n\n${DATE_BLOCK}`,
    )
  })

  it('sends user text verbatim and adds no hidden sections', () => {
    const prompt = composeSystemPrompt({
      systemPrompt: 'Base prompt',
      rules: 'Rule A\nRule B',
      today: TODAY,
    })
    expect(prompt).toBe(`Base prompt\n\nRule A\nRule B\n\n${DATE_BLOCK}`)
    expect(prompt).not.toContain('铁律')
    expect(prompt).not.toContain('目录约定')
  })

  it('injects the skills index only when explicitly enabled', () => {
    const index = '- Skill（id: skill）：desc；触发词：无'
    expect(composeSystemPrompt({ skillsIndex: index, today: TODAY })).toBe(
      `${DEFAULT_SYSTEM_PROMPT}\n\n${DATE_BLOCK}`,
    )
    expect(
      composeSystemPrompt({ skillsIndex: index, injectSkills: true, today: TODAY }),
    ).toBe(`${DEFAULT_SYSTEM_PROMPT}\n\n${index}\n\n${DATE_BLOCK}`)
  })

  it('derives the local date when no override is supplied', () => {
    expect(composeSystemPrompt({})).toMatch(/Today is \d{4}-\d{2}-\d{2}\.$/)
  })
})
