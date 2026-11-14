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
 * Default base prompt; Settings shows and sends this exact text.
 * Keep in sync with `DEFAULT_SYSTEM_PROMPT` in src-tauri/src/agent/model_store.rs.
 */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant running LifeOS.'

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
