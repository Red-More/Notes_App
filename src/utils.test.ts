import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  dateStr,
  diffLines,
  exportTs,
  fmtVersion,
  formatDateTime,
  formatRelative,
  friendlyError,
  monthStr,
  parseDbTime,
  safeFileName,
  shortTime,
} from './utils'

describe('parseDbTime', () => {
  it('解析 SQLite 本地时间字符串为 Date', () => {
    const d = parseDbTime('2026-10-14 09:30:00')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(9)
    expect(d.getDate()).toBe(14)
    expect(d.getHours()).toBe(9)
    expect(d.getMinutes()).toBe(30)
    expect(d.getSeconds()).toBe(0)
  })
})

describe('formatDateTime', () => {
  it('格式化为 YYYY-MM-DD HH:mm', () => {
    expect(formatDateTime('2026-10-14 09:30:00')).toBe('2026-10-14 09:30')
  })

  it('月份与时间补零', () => {
    expect(formatDateTime('2026-01-05 08:05:59')).toBe('2026-01-05 08:05')
  })
})

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 9, 14, 10, 0, 0)) // 固定“当前时间”为 2026-10-14 10:00:00
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('一分钟内显示“刚刚”', () => {
    expect(formatRelative('2026-10-14 09:59:30')).toBe('刚刚')
  })

  it('一小时内显示“n分钟前”', () => {
    expect(formatRelative('2026-10-14 09:55:00')).toBe('5分钟前')
  })

  it('24 小时内显示“n小时前”', () => {
    expect(formatRelative('2026-10-14 08:00:00')).toBe('2小时前')
  })

  it('昨天显示“昨天”', () => {
    expect(formatRelative('2026-10-13 09:00:00')).toBe('昨天')
  })

  it('7 天内显示“n天前”', () => {
    expect(formatRelative('2026-10-11 10:00:00')).toBe('3天前')
  })

  it('同年更早日期显示“M月d日”', () => {
    expect(formatRelative('2026-03-05 10:00:00')).toBe('3月5日')
  })

  it('跨年日期显示“yyyy年M月d日”', () => {
    expect(formatRelative('2025-12-31 10:00:00')).toBe('2025年12月31日')
  })
})

describe('dateStr', () => {
  it('格式化为 YYYY-MM-DD', () => {
    expect(dateStr(new Date(2026, 9, 14))).toBe('2026-10-14')
  })

  it('月份补零', () => {
    expect(dateStr(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('monthStr', () => {
  it('格式化为 YYYY-MM', () => {
    expect(monthStr(new Date(2026, 9, 14))).toBe('2026-10')
    expect(monthStr(new Date(2026, 0, 5))).toBe('2026-01')
  })
})

describe('fmtVersion', () => {
  it('数字版本号格式化为 v{major}.{minor}.{patch}', () => {
    expect(fmtVersion(123)).toBe('v1.2.3')
    expect(fmtVersion(7)).toBe('v0.0.7')
    expect(fmtVersion(0)).toBe('v0.0.0')
    expect(fmtVersion(99)).toBe('v0.9.9')
    expect(fmtVersion(1000)).toBe('v10.0.0')
  })
})

describe('shortTime', () => {
  it('提取 HH:mm', () => {
    expect(shortTime('2026-10-14 09:30:00')).toBe('09:30')
    expect(shortTime('2026-10-14 09:30')).toBe('09:30')
  })

  it('null / undefined / 空串返回空串', () => {
    expect(shortTime(null)).toBe('')
    expect(shortTime(undefined)).toBe('')
    expect(shortTime('')).toBe('')
  })

  it('不足 16 字符时原样返回', () => {
    expect(shortTime('09:30')).toBe('09:30')
  })
})

describe('diffLines', () => {
  it('内容相同时全部为 same', () => {
    const rows = diffLines('a\nb', 'a\nb')
    expect(rows).toEqual([
      { type: 'same', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'same', text: 'b', oldNo: 2, newNo: 2 },
    ])
  })

  it('新增行标记为 add', () => {
    const rows = diffLines('a\nc', 'a\nb\nc')
    expect(rows).toEqual([
      { type: 'same', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'add', text: 'b', oldNo: null, newNo: 2 },
      { type: 'same', text: 'c', oldNo: 2, newNo: 3 },
    ])
  })

  it('删除行标记为 del 且排在 add 之前', () => {
    const rows = diffLines('a\nb', 'a\nc')
    expect(rows).toEqual([
      { type: 'same', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2, newNo: null },
      { type: 'add', text: 'c', oldNo: null, newNo: 2 },
    ])
  })

  it('旧文本为空时全部为 add', () => {
    const rows = diffLines('', 'a\nb')
    expect(rows).toEqual([
      { type: 'add', text: 'a', oldNo: null, newNo: 1 },
      { type: 'add', text: 'b', oldNo: null, newNo: 2 },
    ])
  })

  it('新文本为空时全部为 del', () => {
    const rows = diffLines('a\nb', '')
    expect(rows).toEqual([
      { type: 'del', text: 'a', oldNo: 1, newNo: null },
      { type: 'del', text: 'b', oldNo: 2, newNo: null },
    ])
  })
})

describe('safeFileName', () => {
  it('替换非法字符为下划线', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('替换控制字符', () => {
    expect(safeFileName('a\u0000b\u0007c')).toBe('a_b_c')
  })

  it('空串或空白回退为“未命名”', () => {
    expect(safeFileName('')).toBe('未命名')
    expect(safeFileName('   ')).toBe('未命名')
  })

  it('支持自定义回退名', () => {
    expect(safeFileName('', '默认')).toBe('默认')
  })

  it('截断到 60 字符', () => {
    expect(safeFileName('x'.repeat(80))).toHaveLength(60)
  })
})

describe('exportTs', () => {
  it('格式化为 YYYYMMDD-HHmm', () => {
    expect(exportTs(new Date(2026, 9, 14, 9, 30))).toBe('20261014-0930')
    expect(exportTs(new Date(2026, 0, 5, 8, 5))).toBe('20260105-0805')
  })
})

describe('friendlyError', () => {
  it('数据库错误映射为统一提示', () => {
    expect(friendlyError('数据库错误: 磁盘已满')).toBe('操作失败，请重试')
    expect(friendlyError(new Error('数据库错误: xxx'))).toBe('操作失败，请重试')
  })

  it('笔记不存在映射为友好提示', () => {
    expect(friendlyError('笔记不存在')).toBe('笔记不存在或已删除')
  })

  it('没有可导出的笔记原样返回', () => {
    expect(friendlyError('没有可导出的笔记')).toBe('没有可导出的笔记')
  })

  it('不能为空类消息原样返回', () => {
    expect(friendlyError('标题不能为空')).toBe('标题不能为空')
  })

  it('未知错误走兜底提示', () => {
    expect(friendlyError('未知错误')).toBe('操作失败，请稍后重试')
    expect(friendlyError(42)).toBe('操作失败，请稍后重试')
    expect(friendlyError(new Error('网络断开'))).toBe('操作失败，请稍后重试')
  })
})
