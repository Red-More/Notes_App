/** Shared file-name rules and the editor's common file types. */

export interface FileTypeOption {
  ext: string
  label: string
}

export const COMMON_FILE_TYPES: FileTypeOption[] = [
  { ext: 'md', label: 'Markdown' },
  { ext: 'txt', label: '纯文本' },
  { ext: 'json', label: 'JSON' },
  { ext: 'js', label: 'JavaScript' },
  { ext: 'ts', label: 'TypeScript' },
  { ext: 'py', label: 'Python' },
  { ext: 'html', label: 'HTML' },
  { ext: 'css', label: 'CSS' },
  { ext: 'yaml', label: 'YAML' },
  { ext: 'csv', label: 'CSV' },
]

const FORBIDDEN = /[\\/:*?"<>|]/
const RESERVED =
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** Human-readable type label, e.g. `Markdown（.md）`. */
export function fileTypeLabel(ext: string): string {
  const known = COMMON_FILE_TYPES.find((type) => type.ext === ext)
  return `${known?.label ?? '自定义'}（.${ext}）`
}

/** Extension of a virtual path, without the dot (lower-case). */
export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? ''
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

/** File name without its last extension. */
export function baseNameOf(path: string): string {
  const base = path.split('/').pop() ?? ''
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(0, index) : base
}

/**
 * Returns a friendly error, or `null` when the base name is acceptable.
 * `allowEmpty` keeps the input usable while the user is still typing.
 */
export function fileNameError(name: string, allowEmpty = true): string | null {
  const error = fileNameTypingError(name, allowEmpty)
  if (error) return error
  // The trailing rule is deferred while typing: "v1.2" must pass through "v1.".
  const value = name.trim()
  if (value.endsWith('.') || value.endsWith(' ')) {
    return '文件名不能以点或空格结尾'
  }
  return null
}

/**
 * Typing-time validation: every rule except the trailing dot/space one, so
 * intermediate keystrokes are not swallowed by the controlled input.
 */
export function fileNameTypingError(name: string, allowEmpty = true): string | null {
  const value = name.trim()
  if (!value) return allowEmpty ? null : '文件名不能为空'
  if (value.length > 120) return '文件名最多 120 个字符'
  if (value === '.' || value === '..') return '文件名不能是 . 或 ..'
  if (FORBIDDEN.test(value) || /[\u0000-\u001f]/.test(value)) {
    return '文件名不能包含 / \\ : * ? " < > | 等字符'
  }
  if (RESERVED.test(value.split('.')[0] ?? value)) return '该文件名是系统保留名称'
  return null
}

/** Normalize a custom extension; accepts a leading dot. */
export function normalizeExtension(raw: string): { ext?: string; error?: string } {
  const ext = raw.trim().replace(/^\.+/, '').toLowerCase()
  if (!ext) return { error: '请输入扩展名' }
  if (ext.length > 16) return { error: '扩展名最多 16 个字符' }
  if (!/^[a-z0-9]+$/.test(ext)) return { error: '扩展名只能包含字母和数字' }
  return { ext }
}
