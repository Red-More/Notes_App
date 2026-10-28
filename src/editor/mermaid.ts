import type { MermaidConfig } from 'mermaid'

export type MermaidTheme = 'light' | 'dark'

type MermaidApi = (typeof import('mermaid'))['default']

export interface MermaidSvgResult {
  svg: string
}

export interface MermaidErrorResult {
  error: string
}

export type MermaidRenderResult = MermaidSvgResult | MermaidErrorResult

/** Design tokens consumed by Mermaid's themeVariables (hex values only). */
export interface MermaidThemeTokens {
  surface: string
  surface2: string
  text: string
  text2: string
  text3: string
  border: string
  accent: string
}

const MAX_CACHE_ENTRIES = 40
const cache = new Map<string, MermaidRenderResult>()

const FONT_FAMILY =
  "system-ui, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Roboto, sans-serif"

let modulePromise: Promise<MermaidApi> | null = null
let initializedKey: string | null = null
let renderSequence = 0

/** Both theme and mode are part of the key: changing either reinitializes Mermaid. */
function modeKey(theme: MermaidTheme, enhance: boolean): string {
  return `${theme}:${enhance ? 'enhanced' : 'legacy'}`
}

/** Cache key: a diagram only needs re-rendering when source, theme or mode changes. */
export function mermaidCacheKey(
  source: string,
  theme: MermaidTheme,
  enhance: boolean,
): string {
  return `${theme}\u0000${enhance ? 'enhanced' : 'legacy'}\u0000${source.trim()}`
}

/** Resolve the active app theme without adding a React dependency. */
export function currentMermaidTheme(): MermaidTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** Read the app's design tokens into plain hex colors for Mermaid. */
export function readMermaidTokens(): MermaidThemeTokens {
  const styles = getComputedStyle(document.documentElement)
  const token = (name: string) => styles.getPropertyValue(name).trim()
  return {
    surface: token('--surface'),
    surface2: token('--surface-2'),
    text: token('--text'),
    text2: token('--text-2'),
    text3: token('--text-3'),
    border: token('--border'),
    accent: token('--accent'),
  }
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

function buildThemeVariables(
  tokens: MermaidThemeTokens,
  enhance: boolean,
): Record<string, string> {
  // The enhanced preset uses white node fills with firmer borders, closer to a
  // drawing tool canvas. The legacy preset reproduces the previous mapping.
  const nodeFill = enhance ? tokens.surface : tokens.surface2
  const nodeBorder = enhance ? tokens.text2 : tokens.text3
  const clusterBorder = enhance ? tokens.text3 : tokens.border

  return {
    background: tokens.surface,
    primaryColor: nodeFill,
    primaryTextColor: tokens.text,
    primaryBorderColor: nodeBorder,
    secondaryColor: tokens.surface,
    tertiaryColor: tokens.surface2,
    lineColor: tokens.text2,
    textColor: tokens.text,
    mainBkg: nodeFill,
    nodeBorder,
    clusterBkg: tokens.surface2,
    clusterBorder,
    defaultLinkColor: tokens.text2,
    titleColor: tokens.text,
    edgeLabelBackground: tokens.surface,
    actorBkg: tokens.surface2,
    actorBorder: nodeBorder,
    actorTextColor: tokens.text,
    signalColor: tokens.text2,
    signalTextColor: tokens.text,
    labelBoxBkgColor: tokens.surface2,
    labelBoxBorderColor: nodeBorder,
    labelTextColor: tokens.text,
    loopTextColor: tokens.text,
    noteBkgColor: tokens.surface2,
    noteTextColor: tokens.text,
    noteBorderColor: nodeBorder,
    sectionBkgColor: tokens.surface,
    altSectionBkgColor: tokens.surface2,
    taskBkgColor: tokens.surface2,
    taskBorderColor: nodeBorder,
    taskTextColor: tokens.text,
    taskTextOutsideColor: tokens.text,
    taskTextLightColor: tokens.text,
    gridColor: tokens.border,
    todayLineColor: tokens.accent,
  }
}

function buildThemeCss(enhance: boolean): string {
  if (!enhance) {
    return `
      .node rect, .node circle, .node ellipse, .node polygon, .node path { stroke-width: 1.2px; }
      .cluster rect { rx: 8px; ry: 8px; }
      .edgeLabel { border-radius: 4px; }
    `
  }
  return `
    .node rect, .node circle, .node ellipse, .node polygon, .node path { stroke-width: 1.2px; }
    .edgePath .path, .flowchart-link { stroke-width: 1.2px; }
    .edgeLabel { font-size: 12px; border-radius: 4px; }
    .cluster rect { rx: 4px; ry: 4px; }
    .cluster-label { font-size: 13px; }
  `
}

/** Build the complete Mermaid config for the selected visual mode. */
export function buildMermaidConfig(
  theme: MermaidTheme,
  tokens: MermaidThemeTokens,
  enhance: boolean,
): MermaidConfig {
  const flowchart = enhance
    ? {
        curve: 'step' as const,
        useMaxWidth: true,
        nodeSpacing: 40,
        rankSpacing: 52,
        padding: 12,
        diagramPadding: 12,
      }
    : {
        curve: 'basis' as const,
        useMaxWidth: true,
        nodeSpacing: 40,
        rankSpacing: 48,
        padding: 12,
      }

  const sequence = enhance
    ? {
        useMaxWidth: true,
        wrap: true,
        actorMargin: 40,
        messageMargin: 30,
        boxMargin: 8,
        noteMargin: 8,
        diagramMarginX: 16,
        diagramMarginY: 16,
      }
    : {
        useMaxWidth: true,
        wrap: true,
        actorMargin: 36,
        diagramMarginX: 12,
        diagramMarginY: 12,
      }

  const classConfig = enhance
    ? {
        useMaxWidth: true,
        layout: 'elk',
        nodeSpacing: 40,
        rankSpacing: 52,
        diagramPadding: 12,
      }
    : { useMaxWidth: true }

  const stateConfig = enhance
    ? {
        useMaxWidth: true,
        layout: 'elk',
        nodeSpacing: 40,
        rankSpacing: 52,
        diagramPadding: 12,
      }
    : { useMaxWidth: true }

  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    logLevel: 'fatal',
    theme: 'base',
    darkMode: theme === 'dark',
    fontFamily: FONT_FAMILY,
    ...(enhance
      ? { look: 'classic' as const, layout: 'elk', fontSize: 14 }
      : {}),
    themeVariables: buildThemeVariables(tokens, enhance),
    themeCSS: buildThemeCss(enhance),
    flowchart,
    sequence,
    gantt: {
      useMaxWidth: true,
      barHeight: 22,
      barGap: 6,
      topPadding: 36,
      leftPadding: 60,
      gridLineStartPadding: 28,
    },
    class: classConfig,
    state: stateConfig,
  }
}

function ensureInitialized(
  mermaid: MermaidApi,
  theme: MermaidTheme,
  enhance: boolean,
): void {
  const key = modeKey(theme, enhance)
  if (initializedKey === key) return
  mermaid.initialize(buildMermaidConfig(theme, readMermaidTokens(), enhance))
  initializedKey = key
}

/**
 * Render one diagram. Failures are converted into a result object so callers
 * can show a friendly fallback instead of letting Mermaid reject the preview.
 */
export async function renderMermaid(
  source: string,
  theme: MermaidTheme,
  enhance: boolean,
): Promise<MermaidRenderResult> {
  const key = mermaidCacheKey(source, theme, enhance)
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
    ensureInitialized(mermaid, theme, enhance)
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
  enhance: boolean,
): boolean {
  const cached = readCache(mermaidCacheKey(source, theme, enhance))
  if (!cached) return false
  applyResult(block, cached, source)
  return true
}

/** Render and apply one diagram; safe to call after the preview HTML changes. */
export async function renderMermaidBlock(
  block: HTMLElement,
  source: string,
  theme: MermaidTheme,
  enhance: boolean,
): Promise<void> {
  if (!block.isConnected) return
  if (applyCachedMermaid(block, source, theme, enhance)) return
  const result = await renderMermaid(source, theme, enhance)
  applyResult(block, result, source)
}
