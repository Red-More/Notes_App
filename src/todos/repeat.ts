import type { RepeatValue } from './todoFile'

export type { RepeatValue }

/**
 * Supported repeat intervals; persisted on the todo frontmatter.
 *
 * Typed against [`RepeatValue`] so this list and the file format can never
 * drift apart.
 */
export const REPEAT_OPTIONS: ReadonlyArray<{ value: RepeatValue; label: string }> = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekday', label: '周一至周五' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
]
