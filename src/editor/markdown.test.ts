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

  it('does not interpret Mermaid or LaTeX blocks', () => {
    const html = renderMarkdownPreview('```mermaid\ngraph TD; A-->B\n```\n\n$$ x^2 $$')
    expect(html).toContain('graph TD; A--&gt;B')
    expect(html).toContain('$$ x^2 $$')
    expect(html).not.toContain('mermaid-diagram')
  })

  it('returns an empty string for blank input', () => {
    expect(renderMarkdownPreview('')).toBe('')
    expect(renderMarkdownPreview('  \n ')).toBe('')
  })
})
