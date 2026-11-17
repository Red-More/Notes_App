//! Contact naming: `{name}-{id}.md`.
//!
//! The name is free text and keeps its dots ("Dr. Smith"); only characters a
//! path cannot hold are refused, and they are **reported** instead of being
//! rewritten, so the user sees exactly which character was rejected. The stable
//! `c_...` id in the file name keeps two contacts with the same name apart and
//! survives a rename.

export const CONTACT_ROOT = '/life/contacts'

// `\p{Cc}` covers control characters; literal control escapes trip no-control-regex.
const ILLEGAL_PATH = /[\\/:*?"<>|\p{Cc}]/u
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** Longest accepted name; `-c_xxxxxxxxxx` (13) must still fit the 120 limit. */
const MAX_NAME_CHARS = 100

export function newContactId(random: () => number = Math.random): string {
  let out = ''
  for (let i = 0; i < 10; i += 1) {
    out += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)] ?? '0'
  }
  return `c_${out}`
}

/**
 * Why a contact name cannot be used as a file name, or null when it can.
 *
 * Only characters a path cannot hold are refused; they are reported, never
 * rewritten. Dots and trailing punctuation are fine because the composed name is
 * `{name}-{id}`, so the name itself never sits next to the extension separator.
 */
export function contactNameError(name: string): string | null {
  const value = name.trim()
  if (!value) return '请输入联系人姓名'
  if ([...value].length > MAX_NAME_CHARS) {
    return `联系人姓名最多 ${MAX_NAME_CHARS} 个字符`
  }
  if (ILLEGAL_PATH.test(value)) {
    return '姓名不能包含 / \\ : * ? " < > | 等字符'
  }
  return null
}

/** `{name}-{id}`: the file base. The extension stays a separate value. */
export function contactBase(name: string, contactId: string): string {
  return `${name.trim()}-${contactId}`
}

/** Stable contact id: frontmatter `id`, else derived from the document inode. */
export function contactIdOf(fields: Record<string, unknown>, docId: number): string {
  const raw = fields.id
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  // Legacy contacts predate the id: derive one so a rename stays deterministic.
  return `c_${docId}`
}

/**
 * Display name of a contact.
 *
 * New contacts keep it in frontmatter `name`. A legacy contact only has a title,
 * which the rename flow rewrites to `{name}-{id}`, so that suffix is stripped.
 */
export function contactDisplayName(
  fields: Record<string, unknown>,
  title: string,
  contactId: string,
): string {
  const explicit = fields.name
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  const suffix = `-${contactId}`
  if (title.endsWith(suffix)) {
    const stripped = title.slice(0, -suffix.length).trim()
    if (stripped) return stripped
  }
  return title
}
