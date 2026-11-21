//! Contact details live in the Markdown body, not in frontmatter.
//!
//! Frontmatter stays system-owned (`kind` / `title` / dates) plus the stable
//! `c_...` id that names the file. Everything the user types — phone, email,
//! company, tag and the free-form note — is written as a readable bullet list so
//! the file still makes sense when opened as plain Markdown.
//!
//! Writes go through [`mergeContactBody`], which rewrites only the label lines
//! and the 备注 section and leaves any other paragraph the user added alone.

/**
 * One tag key and the values selected under it.
 *
 * A key owns a list of values, so `城市` can hold both `北京` and `上海` at
 * once. `multiple` is the picker's selection mode: single-select replaces the
 * value, multi-select toggles it. Both modes are persisted in the body.
 */
export interface ContactTagGroup {
  key: string
  values: string[]
  multiple: boolean
}

/** The user-owned half of a contact; `name` lives in the file name instead. */
export interface ContactDetails {
  phone: string | null
  email: string | null
  company: string | null
  notes: string | null
  tags: ContactTagGroup[]
}

export const DEFAULT_CONTACT_TAG = '默认'
/** Default tag key; legacy `- 标签：客户` lines migrate into it. */
export const DEFAULT_TAG_KEY = '类别'

type DetailKey = 'phone' | 'email' | 'company'
type LabelKey = DetailKey | 'tag'

/** Canonical label order and the details key each one maps to. */
const LABELS: Array<{ label: string; key: DetailKey }> = [
  { label: '电话', key: 'phone' },
  { label: '邮箱', key: 'email' },
  { label: '公司', key: 'company' },
]

const TAG_LABEL = '标签'
/** Marks a multi-select key in the stored line, e.g. `城市（多选）=北京`. */
const MULTI_SUFFIX = '（多选）'
const TAG_VALUE_SEP = /[、,，]/

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

function labelOf(key: DetailKey): string {
  return LABELS.find((entry) => entry.key === key)?.label ?? ''
}

function keyOfLabel(label: string): LabelKey | null {
  const trimmed = label.trim()
  if (trimmed === TAG_LABEL) return 'tag'
  const found = LABELS.find((entry) => entry.label === trimmed)
  return found ? found.key : null
}

/** One detail as it should be written; empty values are simply omitted. */
function detailLine(key: DetailKey, details: ContactDetails): string | null {
  const raw = details[key]
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return null
  return `- ${labelOf(key)}：${value}`
}

/** Split a tag value list on any accepted separator. */
function splitTagValues(raw: string): string[] {
  return raw
    .split(TAG_VALUE_SEP)
    .map((value) => value.trim())
    .filter(Boolean)
}

/**
 * Parse one `- 标签：…` value.
 *
 * Canonical form is `key=value、value`, with `（多选）` marking a multi-select
 * key. A legacy line without `=` is a single `类别` value (`- 标签：客户`).
 */
export function parseTagValue(raw: string): ContactTagGroup | null {
  const text = raw.trim()
  if (!text) return null
  const separator = text.indexOf('=')
  if (separator < 0) {
    const values = splitTagValues(text)
    if (values.length === 0) return null
    return { key: DEFAULT_TAG_KEY, values, multiple: values.length > 1 }
  }
  const rawKey = text.slice(0, separator).trim()
  const multiple = rawKey.endsWith(MULTI_SUFFIX)
  const key = (multiple ? rawKey.slice(0, -MULTI_SUFFIX.length) : rawKey).trim()
  const values = splitTagValues(text.slice(separator + 1))
  if (!key || values.length === 0) return null
  return { key, values: multiple ? values : values.slice(0, 1), multiple }
}

/** Merge one parsed group into the accumulator, keeping one entry per key. */
function mergeTagGroup(groups: ContactTagGroup[], incoming: ContactTagGroup): void {
  const existing = groups.find((group) => group.key === incoming.key)
  if (!existing) {
    groups.push({ ...incoming, values: [...incoming.values] })
    return
  }
  existing.multiple = existing.multiple || incoming.multiple
  for (const value of incoming.values) {
    if (!existing.values.includes(value)) existing.values.push(value)
  }
  if (!existing.multiple) existing.values = existing.values.slice(0, 1)
}

/** Canonical tag lines: one readable bullet per key. */
function tagLines(tags: ContactTagGroup[]): string[] {
  const merged: ContactTagGroup[] = []
  for (const group of tags) {
    const key = group.key.trim()
    const values = group.values.map((value) => value.trim()).filter(Boolean)
    if (!key || values.length === 0) continue
    mergeTagGroup(merged, {
      key,
      values: group.multiple ? values : values.slice(0, 1),
      multiple: group.multiple,
    })
  }
  return merged.map(
    (group) => `- ${TAG_LABEL}：${group.key}${group.multiple ? MULTI_SUFFIX : ''}=${group.values.join('、')}`,
  )
}

function labelBlock(details: ContactDetails): string[] {
  const lines = LABELS.map((entry) => detailLine(entry.key, details)).filter(
    (line): line is string => line !== null,
  )
  return [...lines, ...tagLines(details.tags)]
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
  const tags: ContactTagGroup[] = []
  for (const index of scanned.labelLines) {
    const match = LABEL_LINE.exec(lines[index] ?? '')
    if (!match) continue
    const key = keyOfLabel(match[1] ?? '')
    if (!key) continue
    const value = (match[2] ?? '').trim()
    if (!value) continue
    if (key === 'tag') {
      const group = parseTagValue(value)
      if (group) mergeTagGroup(tags, group)
      continue
    }
    out[key] = value
  }
  if (tags.length > 0) out.tags = tags
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
