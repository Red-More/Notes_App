const OPENABLE_URL = /^(https?:|mailto:|tel:)/i

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Open a URL in the platform browser / mail / dialer. Uses Tauri's opener
 * plugin when available and falls back to window.open on the web.
 */
export async function openExternal(url: string): Promise<boolean> {
  if (!OPENABLE_URL.test(url)) return false

  if (isTauriRuntime()) {
    try {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
      return true
    } catch (error) {
      console.error('Failed to open external URL with the system opener', error)
    }
  }

  try {
    const opened = window.open(url, '_blank')
    if (opened) {
      opened.opener = null
      return true
    }
    return false
  } catch {
    return false
  }
}
