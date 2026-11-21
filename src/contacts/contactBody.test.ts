import { describe, expect, it } from 'vitest'
import { composeContactBody, mergeContactBody, parseContactBody } from './contactBody'

const details = {
  phone: '138 0000 0000',
  email: 'a@b.com',
  company: '星尘',
  notes: '在读书会认识',
  tags: [{ key: '类别', values: ['客户'], multiple: false }],
}

describe('composeContactBody', () => {
  it('writes one readable bullet per filled field', () => {
    expect(composeContactBody(details)).toBe(
      [
        '- 电话：138 0000 0000',
        '- 邮箱：a@b.com',
        '- 公司：星尘',
        '- 标签：类别=客户',
        '',
        '## 备注',
        '',
        '在读书会认识',
      ].join('\n'),
    )
  })

  it('omits empty fields instead of writing empty bullets', () => {
    const body = composeContactBody({ ...details, phone: null, company: '  ', notes: null })
    expect(body).toBe(['- 邮箱：a@b.com', '- 标签：类别=客户'].join('\n'))
    expect(body).not.toContain('电话')
    expect(body).not.toContain('## 备注')
  })

  it('writes multi-select groups with every value on one line', () => {
    const body = composeContactBody({
      ...details,
      tags: [
        { key: '类别', values: ['客户'], multiple: false },
        { key: '城市', values: ['北京', '上海'], multiple: true },
      ],
    })
    expect(body).toContain('- 标签：类别=客户')
    expect(body).toContain('- 标签：城市（多选）=北京、上海')
  })
})

describe('parseContactBody', () => {
  it('round-trips what composeContactBody wrote', () => {
    expect(parseContactBody(composeContactBody(details))).toEqual(details)
  })

  it('reads a body a person may have typed by hand', () => {
    const body = ['* 电话: 110', '* 公司 : 星尘', '', '## 备注', '', '随手记', '第二行'].join('\r\n')
    expect(parseContactBody(body)).toEqual({
      phone: '110',
      company: '星尘',
      notes: '随手记\n第二行',
    })
  })

  it('reads legacy single tags into the default 类别 key', () => {
    const body = ['- 电话：', '- 生日：1 月 1 日', '- 标签：朋友'].join('\n')
    expect(parseContactBody(body)).toEqual({
      tags: [{ key: '类别', values: ['朋友'], multiple: false }],
    })
  })

  it('merges repeated lines of the same multi-select key', () => {
    const body = ['- 标签：城市（多选）=北京', '- 标签：城市（多选）=上海'].join('\n')
    expect(parseContactBody(body)).toEqual({
      tags: [{ key: '城市', values: ['北京', '上海'], multiple: true }],
    })
  })

  it('returns an empty object for a blank or plain-prose body', () => {
    expect(parseContactBody('')).toEqual({})
    expect(parseContactBody('就是一段普通文字')).toEqual({})
  })

  it('does not read label-looking lines out of the 备注 section', () => {
    // 备注里是用户自己的记录，长得像字段也不该被当成字段读走。
    const body = ['- 电话：110', '', '## 备注', '', '- 电话：这是他家里的号码', '- 标签：别动'].join(
      '\n',
    )
    expect(parseContactBody(body)).toEqual({
      phone: '110',
      notes: '- 电话：这是他家里的号码\n- 标签：别动',
    })
  })
})

describe('mergeContactBody', () => {
  it('creates a body when the file has none', () => {
    expect(mergeContactBody('', details)).toBe(composeContactBody(details))
  })

  it('replaces only the label lines and the 备注 section', () => {
    // 加粗标题也得当作标题：有的编辑器会把选中的行整体加粗。
    const existing = [
      '- 电话：110',
      '- 标签：朋友',
      '',
      '## 备注',
      '',
      '旧备注',
      '',
      '**## 其他**',
      '',
      '别删我',
    ].join('\n')

    const merged = mergeContactBody(existing, { ...details, notes: '新备注' })

    expect(merged).toContain('- 电话：138 0000 0000')
    expect(merged).toContain('- 标签：类别=客户')
    expect(merged).not.toContain('- 电话：110')
    expect(merged).not.toContain('旧备注')
    expect(merged).toContain('新备注')
    // 表单没管的段落必须原样留下。
    expect(merged).toContain('**## 其他**')
    expect(merged).toContain('别删我')
  })

  it('normalizes a bolded 备注 heading back to the canonical shape', () => {
    const existing = ['- 电话：110', '', '**## 备注**', '', '加粗标题下的备注'].join('\n')

    const merged = mergeContactBody(existing, { ...details, notes: '新备注' })

    // 读取时识别了加粗标题，保存时归一成规范写法，且不会再叠出第二段。
    expect(merged).toContain('## 备注')
    expect(merged).not.toContain('**## 备注**')
    expect(merged.match(/## 备注/g)).toHaveLength(1)
    expect(merged).toContain('新备注')
    expect(merged).not.toContain('加粗标题下的备注')
  })

  it('reads details out of a body whose 备注 heading is bolded', () => {
    const body = ['- 电话：110', '', '**## 备注**', '', '随手记'].join('\n')
    expect(parseContactBody(body)).toEqual({ phone: '110', notes: '随手记' })
  })

  it('drops the 备注 section when the note is cleared', () => {
    const merged = mergeContactBody('- 标签：客户\n\n## 备注\n\n旧备注', {
      ...details,
      notes: null,
    })
    expect(merged).not.toContain('## 备注')
    expect(merged).not.toContain('旧备注')
    expect(merged).toBe(
      '- 电话：138 0000 0000\n- 邮箱：a@b.com\n- 公司：星尘\n- 标签：类别=客户',
    )
  })

  it('appends the 备注 section to a file that has prose but no labels', () => {
    const merged = mergeContactBody('一段自由记录', details)
    // 用户写的散文留在原处，结构化字段补在后面。
    expect(merged.startsWith('一段自由记录')).toBe(true)
    expect(merged).toContain('- 电话：138 0000 0000')
    expect(merged).toContain('## 备注')
    expect(merged).toContain('在读书会认识')
  })

  it('is idempotent: merging the same details twice changes nothing', () => {
    const once = mergeContactBody('', details)
    expect(mergeContactBody(once, details)).toBe(once)
  })

  it('leaves label-looking lines inside 备注 where the user put them', () => {
    const existing = ['- 电话：110', '', '## 备注', '', '- 电话：家里的号码'].join('\n')
    const merged = mergeContactBody(existing, { ...details, phone: '119', notes: '- 电话：家里的号码' })
    expect(merged).toContain('- 电话：119')
    expect(merged).not.toContain('- 电话：110')
    // 备注里的那行原样留在备注里，没有被搬到字段区。
    expect(merged.match(/- 电话：家里的号码/g)).toHaveLength(1)
    expect(merged.indexOf('- 电话：家里的号码')).toBeGreaterThan(merged.indexOf('## 备注'))
  })

  it('never leaves two blank lines in a row', () => {
    const merged = mergeContactBody('- 标签：客户\n\n\n\n## 备注\n\n\n\n旧', details)
    expect(merged).not.toMatch(/\n{3}/)
  })
})
