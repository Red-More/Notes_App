import { describe, expect, it } from 'vitest'
import { sanitizeHtml } from './sanitizeHtml'

describe('sanitizeHtml', () => {
  it('keeps allowlisted tags and attributes', () => {
    expect(sanitizeHtml('<p class="note"><strong>好</strong></p>')).toBe(
      '<p class="note"><strong>好</strong></p>',
    )
  })

  it('drops raw-text containers together with their content', () => {
    expect(sanitizeHtml('<script>alert(1)</script><b>ok</b>')).toBe('<b>ok</b>')
    expect(sanitizeHtml('<style>.x{}</style>正文')).toBe('正文')
  })

  it('drops event handlers and style attributes', () => {
    expect(sanitizeHtml('<img src="https://x/y.png" onerror="alert(1)" style="color:red">')).toBe(
      '<img src="https://x/y.png">',
    )
    expect(sanitizeHtml('<p onclick="x()">文</p>')).toBe('<p>文</p>')
  })

  it('blocks dangerous URLs but allows raster data images', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>')
    expect(sanitizeHtml('<a href="java\nscript:alert(1)">x</a>')).toBe('<a>x</a>')
    expect(sanitizeHtml('<img src="data:text/html;base64,xx">')).toBe('<img>')
    expect(sanitizeHtml('<img src="data:image/png;base64,AA">')).toBe(
      '<img src="data:image/png;base64,AA">',
    )
  })

  it('keeps task-list checkboxes and drops other inputs', () => {
    expect(
      sanitizeHtml('<input class="task-list-item-checkbox" disabled type="checkbox" checked>'),
    ).toBe('<input class="task-list-item-checkbox" disabled="" type="checkbox" checked="">')
    expect(sanitizeHtml('<input type="text" value="x">')).toBe('')
  })

  it('unwraps unknown tags but keeps their text', () => {
    expect(sanitizeHtml('<custom>文字</custom>')).toBe('文字')
    expect(sanitizeHtml('<iframe src="x">降级</iframe>')).toBe('降级')
  })

  it('keeps independently tokenized open and close tags paired', () => {
    expect(sanitizeHtml('<span>')).toBe('<span>')
    expect(sanitizeHtml('</span>')).toBe('</span>')
    expect(sanitizeHtml('<br>')).toBe('<br>')
  })

  it('escapes emitted attribute values', () => {
    expect(sanitizeHtml('<a title=\'"x"\'>y</a>')).toBe('<a title="&quot;x&quot;">y</a>')
  })
})
