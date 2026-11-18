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
// \p{Cc} covers every control character (C0, DEL and C1) and matches the Rust
// side's `char::is_control`, so the UI never accepts a name the backend rejects.
const CONTROL = /\p{Cc}/u
const RESERVED =
  /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** Human-readable type label, e.g. `Markdown（.md）`. */
export function fileTypeLabel(ext: string): string {
  if (!ext) return '无扩展名'
  // Extensions keep their original case, so `.MD` must still match Markdown.
  const known = COMMON_FILE_TYPES.find((type) => type.ext.toLowerCase() === ext.toLowerCase())
  return `${known?.label ?? '自定义'}（.${ext}）`
}

/**
 * Default name of a single-document export.
 *
 * `base` is the editor title (file name without its extension) and `ext` is the
 * persisted extension, so `spec.draft` stays one extension and an empty one adds
 * no separator dot. The result always matches the name shown in the editor;
 * only the image bundle changes the container to `.zip`.
 */
export function exportFileName(base: string, ext: string, withImages: boolean): string {
  const name = base.trim() || '未命名'
  const document = ext ? `${name}.${ext}` : name
  // The image bundle only wraps the document, so the document name survives.
  return withImages ? `${document}.zip` : document
}

/**
 * File name without its persisted extension.
 *
 * When `ext` is empty the whole name is the base, so `v1.2` keeps its dot.
 */
export function baseNameOf(path: string, ext?: string): string {
  const base = path.split('/').pop() ?? ''
  if (!ext) return base
  const suffix = `.${ext.toLowerCase()}`
  return base.toLowerCase().endsWith(suffix) ? base.slice(0, -suffix.length) : base
}

/**
 * Returns a friendly error, or `null` when the base name is acceptable.
 * `allowEmpty` keeps the input usable while the user is still typing.
 */
export function fileNameError(name: string, allowEmpty = true): string | null {
  return fileNameTypingError(name, allowEmpty)
}

/**
 * Base-name validation: dots belong to the extension picker, so the base must
 * not contain any.
 */
export function fileNameTypingError(name: string, allowEmpty = true): string | null {
  const value = name.trim()
  if (!value) return allowEmpty ? null : '文件名不能为空'
  if (value.length > 120) return '文件名最多 120 个字符'
  if (FORBIDDEN.test(value) || CONTROL.test(value)) {
    return '文件名不能包含 / \\ : * ? " < > | 等字符'
  }
  if (value.includes('.')) return '文件名不能包含点号，扩展名请单独选择'
  if (RESERVED.test(value)) return '该文件名是系统保留名称'
  return null
}

/**
 * Normalize a custom extension; accepts a leading dot.
 *
 * The extension may contain further dots (`tar.gz`) and its case is preserved
 * exactly as typed. `allowEmpty` lets the caller pick "no extension".
 */
export function normalizeExtension(
  raw: string,
  allowEmpty = false,
): { ext?: string; error?: string } {
  const ext = raw.trim().replace(/^\.+/, '')
  if (!ext) return allowEmpty ? { ext: '' } : { error: '请输入扩展名' }
  if ([...ext].length > 16) return { error: '扩展名最多 16 个字符' }
  if (/[\s\\/:*?"<>|]/.test(ext) || CONTROL.test(ext)) {
    return { error: '扩展名不能包含空格或 / \\ : * ? " < > | 等字符' }
  }
  if (ext.endsWith('.')) return { error: '扩展名不能以点结尾' }
  return { ext }
}
