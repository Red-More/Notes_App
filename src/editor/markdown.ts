import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it'
import katex from 'katex'
import katexPluginImport from '@vscode/markdown-it-katex'
import hljs from 'highlight.js/lib/common'
import taskLists from 'markdown-it-task-lists'

// The plugin ships as CJS; dev/prod interop may expose the whole exports object
// as the default import, so unwrap its `.default` when necessary.
const katexPlugin =
  typeof katexPluginImport === 'function'
    ? katexPluginImport
    : (katexPluginImport as unknown as { default: typeof katexPluginImport }).default

/** Highlight fenced code with highlight.js; unknown languages stay plain. */
function highlightCode(code: string, language: string): string {
  const name = language.trim().split(/\s+/)[0]?.toLowerCase()
  if (!name || !hljs.getLanguage(name)) return ''
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  } catch {
    return ''
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function mathErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Inline math; malformed formulas degrade to a readable label, never throw. */
function renderInlineMath(source: string): string {
  try {
    return katex.renderToString(source, {
      displayMode: false,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
    })
  } catch (error) {
    return `<span class="math-error math-error-inline" role="alert" title="${escapeHtml(
      mathErrorText(error),
    )}">公式语法错误</span>`
  }
}

/** Block math; keeps the source line for scroll sync and shows a friendly error. */
function renderBlockMath(source: string, line: number | undefined): string {
  const attr = line == null ? '' : ` data-line="${line + 1}"`
  try {
    const body = katex.renderToString(source, {
      displayMode: true,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
    })
    return `<div class="math-block"${attr}>${body}</div>\n`
  } catch (error) {
    return (
      `<div class="math-block math-error"${attr} role="alert">` +
      '<div class="math-error-title">公式语法错误</div>' +
      `<pre class="math-error-source">${escapeHtml(source)}</pre>` +
      `<div class="math-error-detail">${escapeHtml(mathErrorText(error))}</div>` +
      '</div>\n'
    )
  }
}

/**
 * Parse `$...$` / `$$...$$` with the VS Code KaTeX plugin, then take over the
 * renderers so invalid formulas can show a custom fallback and block math can
 * carry a source line for preview scroll sync.
 */
function configureMath(md: MarkdownItInstance): void {
  md.use(katexPlugin, { katex })
  const rules = md.renderer.rules
  rules.math_inline = (tokens, idx) => renderInlineMath(tokens[idx].content)
  for (const type of ['math_inline_block', 'math_block', 'math_inline_bare_block'] as const) {
    rules[type] = (tokens, idx) =>
      renderBlockMath(tokens[idx].content, tokens[idx].map?.[0])
  }
}

/**
 * Annotate block tokens with their 1-based source line so the preview can map
 * blocks back to the editor for two-way scroll sync and click-to-source.
 */
const TABLE_INNER_TAGS = new Set(['table', 'thead', 'tbody', 'tr', 'th', 'td'])

function annotateSourceLines(md: MarkdownItInstance): void {
  const renderer = md.renderer
  const baseRenderToken = renderer.renderToken.bind(renderer)
  renderer.renderToken = (tokens, idx, options) => {
    const token = tokens[idx]

    // markdown-it renders tables through renderToken; wrap them in a scroll
    // container (needed on narrow screens) and put the source line on it.
    if (token.type === 'table_open') {
      const line = token.map?.[0]
      const attr = line == null ? '' : ` data-line="${line + 1}"`
      return `<div class="table-scroll"${attr}>${baseRenderToken(tokens, idx, options)}`
    }
    if (token.type === 'table_close') {
      return `${baseRenderToken(tokens, idx, options)}</div>`
    }

    // Skip table internals: their offsetParent is the table, not the preview
    // scroller, so they cannot be used for scroll mapping.
    if (token.map && token.nesting >= 0 && !TABLE_INNER_TAGS.has(token.tag)) {
      token.attrSet('data-line', String(token.map[0] + 1))
    }
    return baseRenderToken(tokens, idx, options)
  }

  // Fences bypass renderToken. Mermaid fences become placeholders rendered by
  // the browser; everything else keeps highlight.js plus a source line.
  const baseFence = renderer.rules.fence
  renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const language = token.info.trim().split(/\s+/)[0]?.toLowerCase()
    const line = token.map?.[0]

    if (language === 'mermaid') {
      const attr = line == null ? '' : ` data-line="${line + 1}"`
      return `<div class="mermaid-block"${attr}><pre class="mermaid-source">${escapeHtml(
        token.content,
      )}</pre></div>\n`
    }

    const html = baseFence(tokens, idx, options, env, self)
    return line == null ? html : html.replace('<pre', `<pre data-line="${line + 1}"`)
  }

  // Indented code blocks still need their source line.
  const baseCodeBlock = renderer.rules.code_block
  renderer.rules.code_block = (tokens, idx, options, env, self) => {
    const html = baseCodeBlock(tokens, idx, options, env, self)
    const line = tokens[idx].map?.[0]
    return line == null ? html : html.replace('<pre', `<pre data-line="${line + 1}"`)
  }
}

/**
 * Preview renderer aligned with VS Code's built-in Markdown preview: CommonMark
 * plus GFM tables, strikethrough, autolinks, task lists, KaTeX math and Mermaid
 * placeholders (diagrams are rendered in the browser). Raw HTML stays disabled.
 */
function createMarkdownRenderer(): MarkdownItInstance {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    highlight: highlightCode,
  })
  md.use(taskLists, { enabled: false, label: true, labelAfter: true })
  configureMath(md)
  annotateSourceLines(md)
  return md
}

const renderer = createMarkdownRenderer()

/** Render note source to safe preview HTML. Empty input renders an empty string. */
export function renderMarkdownPreview(source: string): string {
  if (!source.trim()) return ''
  return renderer.render(source)
}
