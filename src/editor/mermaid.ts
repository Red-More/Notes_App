export type MermaidTheme = 'light' | 'dark'

type MermaidApi = (typeof import('mermaid'))['default']

export interface MermaidSvgResult {
  svg: string
}

export interface MermaidErrorResult {
  error: string
}

export type MermaidRenderResult = MermaidSvgResult | MermaidErrorResult

const MAX_CACHE_ENTRIES = 40
const cache = new Map<string, MermaidRenderResult>()

let modulePromise: Promise<MermaidApi> | null = null
let initializedTheme: MermaidTheme | null = null
let renderSequence = 0

/** Cache key: a diagram only needs re-rendering when its source or theme changes. */
export function mermaidCacheKey(source: string, theme: MermaidTheme): string {
  return `${theme}\u0000${source.trim()}`
}

/** Resolve the active app theme without adding a React dependency. */
export function currentMermaidTheme(): MermaidTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function describeMermaidError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readCache(key: string): MermaidRenderResult | undefined {
  const cached = cache.get(key)
  if (cached) {
    // Refresh insertion order so frequently used diagrams survive eviction.
    cache.delete(key)
    cache.set(key, cached)
  }
  return cached
}

function writeCache(key: string, result: MermaidRenderResult): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, result)
}

/** Load Mermaid lazily; notes without diagrams never download the engine. */
function loadMermaid(): Promise<MermaidApi> {
  if (!modulePromise) {
    modulePromise = import('mermaid')
      .then((module) => module.default)
      .catch((error) => {
        modulePromise = null
        throw error
      })
  }
  return modulePromise
}

function ensureInitialized(mermaid: MermaidApi, theme: MermaidTheme): void {
  if (initializedTheme === theme) return
  const styles = getComputedStyle(document.documentElement)
  const token = (name: string) => styles.getPropertyValue(name).trim()

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    logLevel: 'fatal',
    theme: 'base',
    darkMode: theme === 'dark',
    fontFamily:
      "system-ui, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Roboto, sans-serif",
    // Align diagram colors with the app's design tokens.
    themeVariables: {
      background: token('--surface'),
      primaryColor: token('--surface-2'),
      primaryTextColor: token('--text'),
      primaryBorderColor: token('--text-3'),
      secondaryColor: token('--surface'),
      tertiaryColor: token('--surface-2'),
      lineColor: token('--text-2'),
      textColor: token('--text'),
      mainBkg: token('--surface-2'),
      nodeBorder: token('--text-3'),
      clusterBkg: token('--surface-2'),
      clusterBorder: token('--border'),
      defaultLinkColor: token('--text-2'),
      titleColor: token('--text'),
      edgeLabelBackground: token('--surface'),
      actorBkg: token('--surface-2'),
      actorBorder: token('--text-3'),
      actorTextColor: token('--text'),
      signalColor: token('--text-2'),
      signalTextColor: token('--text'),
      labelBoxBkgColor: token('--surface-2'),
      labelBoxBorderColor: token('--text-3'),
      labelTextColor: token('--text'),
      loopTextColor: token('--text'),
      noteBkgColor: token('--surface-2'),
      noteTextColor: token('--text'),
      noteBorderColor: token('--text-3'),
      sectionBkgColor: token('--surface'),
      altSectionBkgColor: token('--surface-2'),
      taskBkgColor: token('--surface-2'),
      taskBorderColor: token('--text-3'),
      taskTextColor: token('--text'),
      taskTextOutsideColor: token('--text'),
      taskTextLightColor: token('--text'),
      gridColor: token('--border'),
      todayLineColor: token('--accent'),
    },
    themeCSS: `
      .node rect, .node circle, .node ellipse, .node polygon, .node path { stroke-width: 1.2px; }
      .cluster rect { rx: 8px; ry: 8px; }
      .edgeLabel { border-radius: 4px; }
    `,
    // More breathing room and smoother edges on narrow screens.
    flowchart: {
      curve: 'basis',
      useMaxWidth: true,
      nodeSpacing: 40,
      rankSpacing: 48,
      padding: 12,
    },
    sequence: {
      useMaxWidth: true,
      wrap: true,
      actorMargin: 36,
      diagramMarginX: 12,
      diagramMarginY: 12,
    },
    gantt: {
      useMaxWidth: true,
      barHeight: 22,
      barGap: 6,
      topPadding: 36,
      leftPadding: 60,
      gridLineStartPadding: 28,
    },
    class: { useMaxWidth: true },
    state: { useMaxWidth: true },
  })
  initializedTheme = theme
}

/**
 * Render one diagram. Failures are converted into a result object so callers
 * can show a friendly fallback instead of letting Mermaid reject the preview.
 */
export async function renderMermaid(
  source: string,
  theme: MermaidTheme,
): Promise<MermaidRenderResult> {
  const key = mermaidCacheKey(source, theme)
  const cached = readCache(key)
  if (cached) return cached

  const trimmed = source.trim()
  if (!trimmed) {
    const empty: MermaidErrorResult = { error: '图表内容为空' }
    writeCache(key, empty)
    return empty
  }

  let mermaid: MermaidApi
  try {
    mermaid = await loadMermaid()
  } catch (error) {
    return { error: `图表引擎加载失败：${describeMermaidError(error)}` }
  }

  try {
    ensureInitialized(mermaid, theme)
    const { svg } = await mermaid.render(`notes-mermaid-${++renderSequence}`, trimmed)
    const result: MermaidSvgResult = { svg }
    writeCache(key, result)
    return result
  } catch (error) {
    const result: MermaidErrorResult = { error: describeMermaidError(error) }
    writeCache(key, result)
    return result
  }
}

function applyResult(block: HTMLElement, result: MermaidRenderResult, source: string): void {
  if (!block.isConnected) return
  block.classList.remove('mermaid-rendered', 'mermaid-failed')

  if ('svg' in result) {
    block.innerHTML = result.svg
    block.classList.add('mermaid-rendered')
    return
  }

  block.textContent = ''
  block.classList.add('mermaid-failed')
  const error = document.createElement('div')
  error.className = 'mermaid-error'
  error.setAttribute('role', 'alert')

  const title = document.createElement('div')
  title.className = 'mermaid-error-title'
  title.textContent = '图表渲染失败'

  const detail = document.createElement('div')
  detail.className = 'mermaid-error-detail'
  detail.textContent = result.error

  const sourceBlock = document.createElement('pre')
  sourceBlock.className = 'mermaid-source'
  sourceBlock.textContent = source

  error.append(title, detail, sourceBlock)
  block.append(error)
}

/** Apply a previously rendered diagram synchronously (before first paint). */
export function applyCachedMermaid(
  block: HTMLElement,
  source: string,
  theme: MermaidTheme,
): boolean {
  const cached = readCache(mermaidCacheKey(source, theme))
  if (!cached) return false
  applyResult(block, cached, source)
  return true
}

/** Render and apply one diagram; safe to call after the preview HTML changes. */
export async function renderMermaidBlock(
  block: HTMLElement,
  source: string,
  theme: MermaidTheme,
): Promise<void> {
  if (!block.isConnected) return
  if (applyCachedMermaid(block, source, theme)) return
  const result = await renderMermaid(source, theme)
  applyResult(block, result, source)
}
