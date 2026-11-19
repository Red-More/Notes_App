//! Contact details live in the Markdown body, not in frontmatter.
//!
//! Frontmatter stays system-owned (`kind` / `title` / dates) plus the stable
//! `c_...` id that names the file. Everything the user types — phone, email,
//! company, tag and the free-form note — is written as a readable bullet list so
//! the file still makes sense when opened as plain Markdown.
//!
//! Writes go through [`mergeContactBody`], which rewrites only the label lines
//! and the 备注 section and leaves any other paragraph the user added alone.

/** The user-owned half of a contact; `name` lives in the file name instead. */
export interface ContactDetails {
  phone: string | null
  email: string | null
  company: string | null
  notes: string | null
  tag: string
}

export const DEFAULT_CONTACT_TAG = '默认'

/** Canonical label order and the details key each one maps to. */
const LABELS: Array<{ label: string; key: keyof ContactDetails }> = [
  { label: '电话', key: 'phone' },
  { label: '邮箱', key: 'email' },
  { label: '公司', key: 'company' },
  { label: '标签', key: 'tag' },
]

const NOTES_HEADING = '## 备注'

/** `- 电话：138…`, tolerating a half-width colon and `*` bullets. */
const LABEL_LINE = /^\s*[-*]\s*([^：:]+?)\s*[：:]\s*(.*)$/
/**
 * Any Markdown heading, tolerating a bolded wrapper (`**## 其他**`).
 *
 * Some editors write `**bold**` around everything the user selected; without
 * this, a bolded heading after 备注 would be swallowed as section content and
 * then rewritten on the next save. Requires a space after the hashes, matching
 * CommonMark, so a line like `##1` never ends the section.
 */
const HEADING_LINE = /^\s{0,3}(?:\*\*)?#{1,6}\s/
/**
 * The 备注 heading itself: `## 备注`, plus a bolded wrapper and a missing
 * space after the hashes. The explicit label makes looser spacing safe here,
 * unlike the generic terminator above.
 */
const NOTES_HEADING_PATTERN = /^\s{0,3}(?:\*\*)?#{1,6}\s*备注\s*(?:\*\*)?$/

function labelOf(key: keyof ContactDetails): string {
  return LABELS.find((entry) => entry.key === key)?.label ?? ''
}

function keyOfLabel(label: string): keyof ContactDetails | null {
  const found = LABELS.find((entry) => entry.label === label.trim())
  return found ? found.key : null
}

/** One detail as it should be written; empty values are simply omitted. */
function detailLine(key: keyof ContactDetails, details: ContactDetails): string | null {
  const raw = details[key]
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return null
  return `- ${labelOf(key)}：${value}`
}

function labelBlock(details: ContactDetails): string[] {
  return LABELS.map((entry) => detailLine(entry.key, details)).filter(
    (line): line is string => line !== null,
  )
}

interface Scanned {
  /** Line index of each `- 标签：…` style line. */
  labelLines: number[]
  /** Line index of the `## 备注` heading, when the body has one. */
  notesHeading: number | null
  /** First line index after the notes heading that belongs to another section. */
  notesEnd: number
}

function scan(body: string): Scanned {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const labelLines: number[] = []
  let notesHeading: number | null = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    // 备注 之前才是字段区：用户在备注里写「- 电话：…」时，那是他的记录，
    // 不该被当成表单字段读走，更不该在下次保存时被搬走。
    if (notesHeading == null && LABEL_LINE.test(line)) {
      labelLines.push(i)
      continue
    }
    if (notesHeading == null && NOTES_HEADING_PATTERN.test(line)) {
      notesHeading = i
    }
  }
  let notesEnd = lines.length
  if (notesHeading != null) {
    for (let i = notesHeading + 1; i < lines.length; i += 1) {
      if (HEADING_LINE.test(lines[i])) {
        notesEnd = i
        break
      }
    }
  }
  return { labelLines, notesHeading, notesEnd }
}

/** Read the details back out of a body; missing keys stay absent. */
export function parseContactBody(body: string): Partial<ContactDetails> {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const scanned = scan(body)
  const out: Partial<ContactDetails> = {}
  for (const index of scanned.labelLines) {
    const match = LABEL_LINE.exec(lines[index] ?? '')
    if (!match) continue
    const key = keyOfLabel(match[1] ?? '')
    if (!key) continue
    const value = (match[2] ?? '').trim()
    if (!value) continue
    if (key === 'tag') out.tag = value
    else out[key] = value
  }
  if (scanned.notesHeading != null) {
    const notes = lines
      .slice(scanned.notesHeading + 1, scanned.notesEnd)
      .join('\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '')
    if (notes) out.notes = notes
  }
  return out
}

/**
 * Rewrite the details of an existing body.
 *
 * Only the label lines and the content under `## 备注` are replaced: any other
 * paragraph the user wrote in the note editor survives, which is what makes
 * editing a contact through the form non-destructive.
 */
export function mergeContactBody(existing: string, details: ContactDetails): string {
  const source = existing.replace(/\r\n/g, '\n')
  const scanned = scan(source)
  const lines = source.split('\n')
  const block = labelBlock(details)
  const notes = details.notes?.replace(/\r\n/g, '\n').trim() ?? ''

  const insertAt =
    scanned.labelLines[0] ?? scanned.notesHeading ?? lines.length
  const labelSet = new Set(scanned.labelLines)
  const out: string[] = []
  let inserted = false
  for (let i = 0; i < lines.length; i += 1) {
    if (!inserted && i === insertAt) {
      out.push(...block)
      inserted = true
    }
    if (labelSet.has(i)) continue
    if (scanned.notesHeading != null && i > scanned.notesHeading && i < scanned.notesEnd) {
      continue
    }
    if (scanned.notesHeading != null && i === scanned.notesHeading) {
      // Rewrite the section in the canonical shape and drop a bolded wrapper,
      // so an editor that re-bolds the heading does not accumulate variants.
      // An empty note removes the section instead of leaving a bare heading.
      if (notes) out.push(NOTES_HEADING, '', ...notes.split('\n'))
      continue
    }
    out.push(lines[i])
  }
  if (!inserted) out.push(...block)

  // No 备注 section yet but the user typed one: append it as its own block.
  if (scanned.notesHeading == null && notes) {
    out.push('', NOTES_HEADING, '', ...notes.split('\n'))
  }

  return normalize(out)
}

/** A brand-new body: the details block plus an optional 备注 section. */
export function composeContactBody(details: ContactDetails): string {
  return mergeContactBody('', details)
}

/** Drop leading/trailing blank lines and collapse runs of blank lines. */
function normalize(lines: string[]): string {
  const out: string[] = []
  for (const line of lines) {
    if (line.trim() === '') {
      // A single blank line separates blocks; never two in a row.
      if (out.length === 0 || out[out.length - 1] === '') continue
      out.push('')
      continue
    }
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
