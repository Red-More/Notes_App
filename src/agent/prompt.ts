//! Prompt payload composition.
//!
//! Every block is user-visible in Settings and is sent upstream verbatim:
//! - base system prompt (defaults to a single English sentence)
//! - optional user-maintained rules (omitted when empty)
//! - optional skills index (only when explicitly enabled)
//! - current local date (rendered in the request preview)
//!
//! No hidden rules, directory maps or section titles are added here.

/**
 * Append a snippet to the rules box without duplicating it.
 *
 * Settings offers snippets as a button, so a second click must not paste the
 * same text twice; the user's own rules are always preserved ahead of it.
 */
export function insertRules(current: string, snippet: string): string {
  const existing = current.trimEnd()
  if (existing.includes(snippet)) return current
  return existing === '' ? snippet : `${existing}\n\n${snippet}`
}

/**
 * Default base prompt; Settings shows and sends this exact text.
 * Keep in sync with `DEFAULT_SYSTEM_PROMPT` in src-tauri/src/agent/model_store.rs.
 */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant running LifeOS.'

/**
 * Rules snippet describing the todo day-file format.
 *
 * Offered in Settings as a one-click insert into the user's own rules box. It is
 * never injected implicitly: the request must stay exactly what the user sees.
 * The format is enforced by the frontend store, so an agent that writes todos
 * another way creates files the app will not list.
 */
export const TODO_FORMAT_RULES = `待办写在 /life/todos/todo-YYYY-MM-DD.md，一天一个文件，不要新建其他文件。
每个待办一行，格式固定：- [ ] {id: t_xxxxxxxxxx} 标题（已完成为 - [x]）。
新条目必须自己生成不重复的 id（t_ 加 10 位小写字母或数字），否则会被当成手写条目。
时间写在标题下面的缩进子项：- due: YYYY-MM-DDTHH:MM 表示截止时间（只显示不提醒），- remind: YYYY-MM-DDTHH:MM 表示提醒（只有它会通知）。
不要改动文件里不属于待办条目的其他文字。`

/** Hard cap enforced by the Rust proxy (`MAX_SYSTEM_BYTES` in llm.rs). */
export const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024

export interface PromptBlocks {
  systemPrompt?: string
  rules?: string
  skillsIndex?: string
  injectSkills?: boolean
  /** Date override for tests; defaults to the local date at composition time. */
  today?: string
}

/** Local date as YYYY-MM-DD so relative dates ("today") stay resolvable. */
function currentDate(): string {
  try {
    return new Date().toLocaleDateString('sv-SE')
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

/**
 * Compose the final system message from visible settings only.
 * Empty blocks are omitted together with their separator; the date goes last
 * so it never interrupts user-authored text.
 */
export function composeSystemPrompt({
  systemPrompt,
  rules,
  skillsIndex,
  injectSkills,
  today,
}: PromptBlocks): string {
  const blocks: string[] = []
  const base = systemPrompt ?? ''
  blocks.push(base.trim() === '' ? DEFAULT_SYSTEM_PROMPT : base)
  if ((rules ?? '').trim() !== '') blocks.push(rules as string)
  if (injectSkills && (skillsIndex ?? '').trim() !== '') blocks.push(skillsIndex as string)
  blocks.push(`Today is ${today ?? currentDate()}.`)
  return blocks.join('\n\n')
}
