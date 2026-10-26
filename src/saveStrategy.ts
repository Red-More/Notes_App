export type SaveStrategyKey = 'smart' | 'leave' | 'manual' | 'interval' | 'realtime'

export interface SaveStrategyMeta {
  key: SaveStrategyKey
  label: string
  /** ⓘ bubble text shown on tap / long-press. */
  hint: string
  /** One-line summary rendered under the selected option. */
  desc: string
}

export const SAVE_STRATEGIES: SaveStrategyMeta[] = [
  {
    key: 'smart',
    label: '智能保存（推荐）',
    hint: '编辑后先标记未保存，在离开、切到后台或定时兜底时合并写入，减少闪存写入频次。',
    desc: '离开 / 后台时合并写入，减少写入频次',
  },
  {
    key: 'leave',
    label: '离开时保存',
    hint: '在返回、切换笔记、切到后台或锁屏时保存；应用异常退出可能丢失最近修改。',
    desc: '返回 / 切换 / 后台 / 锁屏时保存',
  },
  {
    key: 'manual',
    label: '手动保存',
    hint: '仅在你点击保存或使用快捷键时写入；离开前若有未保存内容会提示。',
    desc: '仅点击保存时写入，离开前会提示',
  },
  {
    key: 'interval',
    label: '定时保存',
    hint: '按设定间隔自动保存；间隔内异常退出可能丢失最近修改。',
    desc: '按设定间隔自动保存',
  },
  {
    key: 'realtime',
    label: '实时保存',
    hint: '停止输入后短延迟即写入；写入最频繁，不建议长期开启。',
    desc: '停止输入后短延迟即写入',
  },
]

export const SAVE_INTERVALS = [1, 5, 10, 30] as const

export const DEFAULT_STRATEGY: SaveStrategyKey = 'smart'
export const DEFAULT_INTERVAL = 5

const STORAGE_KEY = 'notes:save-strategy'

export interface SaveStrategy {
  key: SaveStrategyKey
  intervalMin: number
}

/** Read the persisted strategy; falls back to smart / 5 min for missing values. */
export function getSaveStrategy(): SaveStrategy {
  let raw: Partial<SaveStrategy> | null = null
  try {
    raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '')
  } catch {
    raw = null
  }
  const key =
    raw && SAVE_STRATEGIES.some((s) => s.key === raw.key)
      ? (raw.key as SaveStrategyKey)
      : DEFAULT_STRATEGY
  const intervalMin =
    raw && typeof raw.intervalMin === 'number' && (SAVE_INTERVALS as readonly number[]).includes(raw.intervalMin)
      ? raw.intervalMin
      : DEFAULT_INTERVAL
  return { key, intervalMin }
}

/** Persist the strategy; takes effect immediately for future editor sessions. */
export function setSaveStrategy(key: SaveStrategyKey, intervalMin = DEFAULT_INTERVAL): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ key, intervalMin }))
}
