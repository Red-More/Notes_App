import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import taskLists from 'markdown-it-task-lists'

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

  // Fenced / indented code bypass renderToken; add the line to their <pre>.
  for (const ruleName of ['fence', 'code_block'] as const) {
    const baseRule = renderer.rules[ruleName]
    renderer.rules[ruleName] = (tokens, idx, options, env, self) => {
      const html = baseRule(tokens, idx, options, env, self)
      const line = tokens[idx].map?.[0]
      return line == null ? html : html.replace('<pre', `<pre data-line="${line + 1}"`)
    }
  }
}

/**
 * Preview renderer aligned with VS Code's built-in Markdown preview: CommonMark
 * plus GFM tables, strikethrough, autolinks and task lists, with highlight.js
 * code coloring. Raw HTML is disabled, so Mermaid, LaTeX and native HTML are
 * intentionally not interpreted (they render as plain source text).
 */
function createMarkdownRenderer(): MarkdownItInstance {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
    highlight: highlightCode,
  })
  md.use(taskLists, { enabled: false, label: true, labelAfter: true })
  annotateSourceLines(md)
  return md
}

const renderer = createMarkdownRenderer()

/** Render note source to safe preview HTML. Empty input renders an empty string. */
export function renderMarkdownPreview(source: string): string {
  if (!source.trim()) return ''
  return renderer.render(source)
}
