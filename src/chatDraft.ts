/**
 * Local-only draft storage for the chat composer.
 *
 * Drafts never enter the conversation list: a chat is only persisted once its
 * first message is sent. Killing the process or switching tabs keeps the text
 * and attachments here, keyed by conversation id (`new` for an unsaved chat).
 */

export interface ChatDraft {
  text: string
  /** Image asset ids referenced by the draft. */
  assetIds: number[]
}

const STORAGE_KEY = 'notes:chat-drafts'
const EMPTY: ChatDraft = { text: '', assetIds: [] }

type DraftMap = Record<string, ChatDraft>

function sanitize(raw: unknown): ChatDraft {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Partial<ChatDraft>
  const text = typeof record.text === 'string' ? record.text : ''
  const assetIds = Array.isArray(record.assetIds)
    ? record.assetIds.filter(
        (id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0,
      )
    : []
  return { text, assetIds: [...new Set(assetIds)] }
}

function readAll(): DraftMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    const out: DraftMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] = sanitize(value)
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(drafts: DraftMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Storage full / private mode: losing a draft is better than breaking chat.
  }
}

export function loadDraft(key: string): ChatDraft {
  return readAll()[key] ?? EMPTY
}

export function saveDraft(key: string, draft: ChatDraft): void {
  const clean = sanitize(draft)
  const all = readAll()
  if (clean.text === '' && clean.assetIds.length === 0) delete all[key]
  else all[key] = clean
  writeAll(all)
}

export function clearDraft(key: string): void {
  const all = readAll()
  if (key in all) {
    delete all[key]
    writeAll(all)
  }
}
