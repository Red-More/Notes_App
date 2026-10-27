import { describe, expect, it } from 'vitest'
import { renderMarkdownPreview } from './markdown'

describe('renderMarkdownPreview', () => {
  it('renders CommonMark headings, emphasis and lists with source lines', () => {
    const html = renderMarkdownPreview('# 标题\n\n**加粗** 和 *斜体*\n\n- 一\n- 二')
    expect(html).toContain('<h1 data-line="1">标题</h1>')
    expect(html).toContain('<strong>加粗</strong>')
    expect(html).toContain('<em>斜体</em>')
    expect(html).toContain('<li data-line="5">一</li>')
  })

  it('keeps single newlines as CommonMark soft breaks', () => {
    const html = renderMarkdownPreview('第一行\n第二行')
    expect(html).toContain('<p data-line="1">第一行\n第二行</p>')
    expect(html).not.toContain('<br>')
  })

  it('escapes raw HTML instead of rendering it', () => {
    const html = renderMarkdownPreview('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('blocks javascript: links', () => {
    const html = renderMarkdownPreview('[x](javascript:alert(1))')
    expect(html).not.toContain('href="javascript:')
  })

  it('autolinks bare URLs', () => {
    const html = renderMarkdownPreview('访问 https://example.com 查看')
    expect(html).toContain('<a href="https://example.com"')
  })

  it('renders GFM tables inside a scroll wrapper', () => {
    const html = renderMarkdownPreview('| A | B |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<div class="table-scroll" data-line="1">')
    expect(html).toContain('<table>')
    expect(html).toContain('<td>1</td>')
  })

  it('renders strikethrough and task lists', () => {
    const html = renderMarkdownPreview('~~删除~~\n\n- [x] 完成\n- [ ] 待办')
    expect(html).toContain('<s>删除</s>')
    expect(html).toContain('contains-task-list')
    expect(html).toContain('task-list-item-checkbox')
    expect(html).toContain('checked=""')
  })

  it('highlights fenced code and annotates its source line', () => {
    const html = renderMarkdownPreview('# A\n\n```js\nconst answer = 42\n```')
    expect(html).toContain('<pre data-line="3">')
    expect(html).toContain('class="language-js"')
    expect(html).toContain('hljs-keyword')
    expect(html).toContain('hljs-number')
  })

  it('keeps unknown languages plain and escaped', () => {
    const html = renderMarkdownPreview('```unknown\nif (a < b) {}\n```')
    expect(html).toContain('if (a &lt; b) {}')
    expect(html).not.toContain('hljs-keyword')
  })

  it('turns Mermaid fences into annotated placeholders', () => {
    const html = renderMarkdownPreview('# 图\n\n```mermaid\ngraph TD;\nA-->B\n```')
    expect(html).toContain('class="mermaid-block" data-line="3"')
    expect(
      html,
    ).toContain('data-mermaid-source="graph%20TD%3B%0AA--%3EB')
    expect(html).toContain('<pre class="mermaid-source">')
    expect(html).toContain('graph TD;')
    expect(html).toContain('A--&gt;B')
    expect(html).not.toContain('hljs')
  })

  it('supports the standard Mermaid diagram families', () => {
    const diagrams = [
      'graph TD; A-->B',
      'sequenceDiagram; A->>B: hello',
      'classDiagram; A <|-- B',
      'stateDiagram-v2; [*] --> A',
      'gantt; dateFormat YYYY-MM-DD; section A; Task :a1, 2024-01-01, 1d',
    ]
    const html = renderMarkdownPreview(
      diagrams.map((diagram) => `\`\`\`mermaid\n${diagram}\n\`\`\``).join('\n\n'),
    )
    expect(html.match(/class="mermaid-source"/g)).toHaveLength(5)
    expect(html).toContain('sequenceDiagram; A-&gt;&gt;B: hello')
    expect(html).toContain('stateDiagram-v2')
  })

  it('matches the Mermaid info string case-insensitively', () => {
    const html = renderMarkdownPreview('```Mermaid\ngraph LR; A-->B\n```')
    expect(html).toContain('class="mermaid-block"')
  })

  it('keeps math markers inside Mermaid sources literal', () => {
    const html = renderMarkdownPreview('```mermaid\ngraph TD; A["$x$"]-->B\n```')
    expect(html).toContain('$x$')
    expect(html).not.toContain('class="katex"')
  })

  it('renders inline LaTeX math', () => {
    const html = renderMarkdownPreview('质能方程 $E=mc^2$ 很著名')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('katex-display')
    expect(html).not.toContain('math-error')
  })

  it('renders block LaTeX math with its source line', () => {
    const html = renderMarkdownPreview('# 公式\n\n$$\n\\frac{a}{b}\n$$')
    expect(html).toContain('<div class="math-block" data-line="3">')
    expect(html).toContain('katex-display')
  })

  it('shows a friendly fallback for invalid inline math', () => {
    const html = renderMarkdownPreview('结果 $\\frac{1}{$ 结束')
    expect(html).toContain('math-error-inline')
    expect(html).toContain('公式语法错误')
  })

  it('shows a friendly fallback with the source for invalid block math', () => {
    const html = renderMarkdownPreview('$$\\notacommand{x}$$')
    expect(html).toContain('math-block math-error')
    expect(html).toContain('公式语法错误')
    expect(html).toContain('math-error-source')
    expect(html).toContain('\\notacommand')
  })

  it('does not treat currency amounts as math', () => {
    const html = renderMarkdownPreview('价格 $20,000 和 $30,000')
    expect(html).not.toContain('class="katex"')
    expect(html).toContain('$20,000')
  })

  it('does not parse math inside code spans', () => {
    const html = renderMarkdownPreview('`$x^2$`')
    expect(html).not.toContain('class="katex"')
    expect(html).toContain('<code>$x^2$</code>')
  })

  it('renders footnotes with working anchors', () => {
    const html = renderMarkdownPreview('正文[^1]\n\n[^1]: 脚注内容')
    expect(html).toContain('class="footnote-ref"')
    expect(html).toContain('href="#fn1"')
    expect(html).toContain('id="fn1"')
    expect(html).toContain('footnote-backref')
    expect(html).toContain('脚注内容')
  })

  it('renders definition lists', () => {
    const html = renderMarkdownPreview('术语\n: 定义')
    expect(html).toContain('<dl data-line="1">')
    expect(html).toContain('>术语</dt>')
    expect(html).toContain('>定义</dd>')
  })

  it('renders abbreviations', () => {
    const html = renderMarkdownPreview(
      '*[HTML]: HyperText Markup Language\n\nHTML',
    )
    expect(html).toContain(
      '<abbr title="HyperText Markup Language">HTML</abbr>',
    )
  })

  it('renders highlight, subscript, superscript and insertion', () => {
    const html = renderMarkdownPreview('==高亮== H~2~O x^2^ ++插入++')
    expect(html).toContain('<mark>高亮</mark>')
    expect(html).toContain('H<sub>2</sub>O')
    expect(html).toContain('x<sup>2</sup>')
    expect(html).toContain('<ins>插入</ins>')
  })

  it('renders emoji shortcodes', () => {
    const html = renderMarkdownPreview('Hello :smile:')
    expect(html).toContain('😄')
  })

  it('keeps extension syntax literal inside code spans', () => {
    const html = renderMarkdownPreview('`==x==`')
    expect(html).toContain('<code>==x==</code>')
    expect(html).not.toContain('<mark>')
  })

  it('returns an empty string for blank input', () => {
    expect(renderMarkdownPreview('')).toBe('')
    expect(renderMarkdownPreview('  \n ')).toBe('')
  })
})
