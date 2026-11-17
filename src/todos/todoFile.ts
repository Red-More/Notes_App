//! `todo-{date}.md` text format.
//!
//! One VFS Markdown file per day holds every todo created that day:
//!
//! ```text
//! ---
//! kind: todo
//! date: 2026-11-17
//! ---
//!
//! - [ ] {id: t_abc123} 买菜
//!   - created: 2026-11-17T09:00:00
//!   - updated: 2026-11-17T09:00:00
//!   - due: 2026-11-17T18:00
//! - [x] {id: t_def456} 发布 v1.2
//!   - created: 2026-11-17T10:00:00
//!   - updated: 2026-11-17T11:00:00
//! ```
//!
//! The id lives on the entry line, so editing the title, ticking the checkbox or
//! moving the entry to another day file never loses the item's identity. Only the
//! non-default sub-items are written (`due`, `pinned`, `repeat`), which keeps a
//! plain todo down to two lines. Unknown sub-items round-trip untouched.

/** Virtual directory holding every day file. Mirrors `docs::util::root_for`. */
export const TODO_ROOT = '/life/todos'

const DAY_FILE = /^todo-(\d{4}-\d{2}-\d{2})\.md$/
const ENTRY = /^- \[([ xX])\]\s*(?:\{id:\s*([^}]+?)\s*\}\s*)?(.*)$/
const SUB_ITEM = /^\s{2,}- ([A-Za-z_][\w-]*):\s*(.*)$/

export type RepeatValue = 'none' | 'daily' | 'weekday' | 'weekly' | 'monthly' | 'yearly'

export interface TodoEntry {
  /** Stable item id (`t_...`); unique across every day file. */
  id: string
  title: string
  done: boolean
  /** Local wall-clock stamp `YYYY-MM-DDTHH:MM:SS`. */
  created: string
  updated: string
  /** Deadline: when the todo is due. Never triggers a notification. */
  due: string | null
  /**
   * Reminder: when to notify. Independent from `due`; only this fires.
   */
  remind: string | null
  pinned: boolean
  repeat: string
  /** Sub-item lines this module does not interpret, kept byte-for-byte. */
  extra: string[]
}

export function todayLocal(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Local wall-clock stamp used inside entries. */
export function localStamp(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}

/** Normalize a database timestamp (`YYYY-MM-DD HH:MM:SS`) to the entry stamp. */
export function normaliseStamp(value: string): string {
  const trimmed = value.trim().replace(' ', 'T')
  return trimmed.length >= 19 ? trimmed.slice(0, 19) : trimmed
}

export function todoDocPath(date: string): string {
  return `${TODO_ROOT}/todo-${date}.md`
}

/** The day a virtual path belongs to, or null when it is not a day file. */
export function todoDateOfPath(path: string): string | null {
  // Only direct children of `/life/todos` are day files; a same-named document
  // elsewhere is an ordinary legacy todo.
  const prefix = `${TODO_ROOT}/`
  if (!path.startsWith(prefix)) return null
  const name = path.slice(prefix.length)
  if (name.includes('/')) return null
  return DAY_FILE.exec(name)?.[1] ?? null
}

export function isTodoDocPath(path: string): boolean {
  return todoDateOfPath(path) !== null
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

export function newTodoId(random: () => number = Math.random): string {
  let out = ''
  for (let i = 0; i < 10; i += 1) {
    out += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)] ?? '0'
  }
  return `t_${out}`
}

/**
 * Deterministic id for a legacy single-todo document.
 *
 * Deriving it from the inode makes the migration idempotent: a re-run after a
 * crash computes the same id and the entry is skipped instead of duplicated.
 */
export function legacyTodoId(inode: number): string {
  return `t_l${inode}`
}

/** Titles are written on one line, so newlines collapse to spaces. */
function oneLine(title: string): string {
  return title.replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Positional id for a checkbox the author wrote without an `{id:}` marker.
 *
 * The ordinal alone is not unique: every day file has a "first checkbox", so two
 * files would both produce `t_p1` and the listing (which dedupes by id) would
 * silently drop one of them. Namespacing by day keeps the fallback stable across
 * re-parses of the same file while staying distinct across files.
 */
export function positionalTodoId(date: string, ordinal: number): string {
  return date ? `t_p${date.replace(/-/g, '')}_${ordinal}` : `t_p${ordinal}`
}

export function parseTodoEntries(body: string, date = ''): TodoEntry[] {
  const entries: TodoEntry[] = []
  let current: TodoEntry | null = null
  let ordinal = 0
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const entry = ENTRY.exec(line)
    if (entry) {
      ordinal += 1
      current = {
        // A hand-written line may omit the id: fall back to a positional one so
        // repeated parses of the same file agree.
        id: entry[2] ?? positionalTodoId(date, ordinal),
        done: entry[1] !== ' ',
        title: (entry[3] ?? '').trim(),
        created: '',
        updated: '',
        due: null,
        remind: null,
        pinned: false,
        repeat: 'none',
        extra: [],
      }
      entries.push(current)
      continue
    }
    if (!current) continue
    const sub = SUB_ITEM.exec(line)
    if (!sub) continue
    const key = sub[1] ?? ''
    const value = (sub[2] ?? '').trim()
    switch (key) {
      case 'created':
        current.created = value
        break
      case 'updated':
        current.updated = value
        break
      case 'due':
        current.due = value || null
        break
      case 'remind':
        current.remind = value || null
        break
      case 'pinned':
        current.pinned = value === 'true'
        break
      case 'repeat':
        current.repeat = value || 'none'
        break
      default:
        // Unknown keys belong to the user: replay them as written.
        current.extra.push(line)
    }
  }
  return entries
}

export function renderTodoEntries(entries: TodoEntry[]): string {
  const blocks = entries.map((entry) => {
    // Trim the headline itself: an empty title would otherwise leave a trailing
    // space before the sub-items, which the parser would keep.
    const headline = `- [${entry.done ? 'x' : ' '}] {id: ${entry.id}} ${oneLine(entry.title)}`
    const lines = [headline.trimEnd()]
    if (entry.created) lines.push(`  - created: ${entry.created}`)
    if (entry.updated) lines.push(`  - updated: ${entry.updated}`)
    if (entry.due) lines.push(`  - due: ${entry.due}`)
    if (entry.remind) lines.push(`  - remind: ${entry.remind}`)
    if (entry.pinned) lines.push('  - pinned: true')
    if (entry.repeat && entry.repeat !== 'none') lines.push(`  - repeat: ${entry.repeat}`)
    lines.push(...entry.extra)
    return lines.join('\n')
  })
  return blocks.length > 0 ? `${blocks.join('\n')}\n` : ''
}

/**
 * True when a body is nothing but entries and their sub-items.
 *
 * Such a file is a pure container: once its last entry is removed there is
 * nothing left to keep, so it can be deleted. A file with hand-written prose is
 * not a container and must never be deleted by the store.
 */
export function isPlainEntryFile(body: string): boolean {
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    if (ENTRY.test(line)) continue
    if (SUB_ITEM.test(line)) continue
    return false
  }
  return true
}

/**
 * Rewrite the entry blocks of a body while keeping every other line.
 *
 * Day files are normally pure containers, but the user (or an agent) may write
 * prose into them. Replacing the whole body with `renderTodoEntries` would
 * silently drop that text, so entries are rewritten in place by id and only
 * genuinely new entries are appended.
 */
export function rewriteTodoBody(body: string, entries: TodoEntry[], date = ''): string {
  const lines = body.split('\n')
  const pending = new Map(entries.map((entry) => [entry.id, entry]))
  const out: string[] = []
  let ordinal = 0
  let index = 0

  while (index < lines.length) {
    const line = (lines[index] ?? '').replace(/\r$/, '')
    const match = ENTRY.exec(line)
    if (!match) {
      out.push(line)
      index += 1
      continue
    }
    ordinal += 1
    const id = match[2] ?? positionalTodoId(date, ordinal)
    // An entry owns the indented sub-item lines that follow it.
    let end = index + 1
    while (end < lines.length && SUB_ITEM.test((lines[end] ?? '').replace(/\r$/, ''))) {
      end += 1
    }
    const next = pending.get(id)
    if (next) {
      out.push(...renderTodoEntries([next]).trimEnd().split('\n'))
      pending.delete(id)
    }
    index = end
  }

  if (pending.size > 0) {
    const appended = renderTodoEntries([...pending.values()]).trimEnd()
    if (appended) {
      // Exactly one blank line separates prose from newly appended entries.
      while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop()
      if (out.length > 0) out.push('')
      out.push(...appended.split('\n'))
    }
  }
  // A body that held only blank lines keeps its shape; anything with real
  // content ends with exactly one newline.
  const joined = out.join('\n')
  return out.some((line) => line.trim() !== '') ? `${joined}\n` : joined
}

/**
 * Completion of a legacy single-todo document that has no `completed` field.
 *
 * Returns null when the body holds no checkbox at all, so the caller can decide
 * the default instead of guessing "done".
 */
export function checkboxCompleted(content: string): boolean | null {
  let found = false
  let allDone = true
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('- [')) continue
    const mark = trimmed[3]
    if (trimmed[4] !== ']') continue
    if (mark !== ' ' && mark !== 'x' && mark !== 'X') continue
    found = true
    if (mark === ' ') allDone = false
  }
  return found ? allDone : null
}
