export type Theme = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'notes:theme'

let media: MediaQueryList | null = null
let listening = false

const systemIsDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

const syncFromSystem = () => {
  const html = document.documentElement
  if (systemIsDark()) {
    html.dataset.theme = 'dark'
  } else {
    delete html.dataset.theme
  }
}

const onSystemChange = () => syncFromSystem()

const listenSystem = () => {
  if (!media) media = window.matchMedia('(prefers-color-scheme: dark)')
  if (!listening) {
    media.addEventListener('change', onSystemChange)
    listening = true
  }
}

const unlistenSystem = () => {
  if (media && listening) {
    media.removeEventListener('change', onSystemChange)
    listening = false
  }
}

/** Read the persisted theme; fall back to 'system' for missing or invalid values. */
export function getStoredTheme(): Theme {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

/**
 * Apply a theme to <html data-theme>. 'dark' sets the attribute, 'light'
 * removes it (:root defaults to light), and 'system' follows the OS
 * preference, live-updating on changes.
 */
export function applyTheme(theme: Theme): void {
  const html = document.documentElement
  if (theme === 'dark') {
    unlistenSystem()
    html.dataset.theme = 'dark'
    return
  }
  if (theme === 'light') {
    unlistenSystem()
    delete html.dataset.theme
    return
  }
  listenSystem()
  syncFromSystem()
}

/** Persist the theme choice and apply it immediately. */
export function setStoredTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme)
  applyTheme(theme)
}
