import { describe, expect, it } from 'vitest'
import {
  buildMermaidConfig,
  describeMermaidError,
  mermaidCacheKey,
  renderMermaid,
  type MermaidThemeTokens,
} from './mermaid'

const TOKENS: MermaidThemeTokens = {
  surface: '#ffffff',
  surface2: '#f2f2f5',
  text: '#1f2128',
  text2: '#8b8d97',
  text3: '#b8bac2',
  border: '#ececf0',
  accent: '#ff7a1a',
}

describe('mermaidCacheKey', () => {
  it('separates themes and visual modes', () => {
    expect(mermaidCacheKey(' graph TD ', 'light', true)).toBe(
      mermaidCacheKey('graph TD', 'light', true),
    )
    expect(mermaidCacheKey('graph TD', 'light', true)).not.toBe(
      mermaidCacheKey('graph TD', 'dark', true),
    )
    expect(mermaidCacheKey('graph TD', 'light', true)).not.toBe(
      mermaidCacheKey('graph TD', 'light', false),
    )
  })
})

describe('buildMermaidConfig', () => {
  it('uses the enhanced visual preset when enabled', () => {
    const config = buildMermaidConfig('light', TOKENS, true)
    expect(config.look).toBe('classic')
    expect(config.layout).toBe('elk')
    expect(config.fontSize).toBe(14)
    expect(config.darkMode).toBe(false)
    expect(config.flowchart).toMatchObject({
      curve: 'step',
      nodeSpacing: 40,
      rankSpacing: 52,
      padding: 12,
      diagramPadding: 12,
    })
    expect(config.sequence).toMatchObject({
      actorMargin: 40,
      messageMargin: 30,
      boxMargin: 8,
      noteMargin: 8,
      diagramMarginX: 16,
      diagramMarginY: 16,
      wrap: true,
    })
    expect(config.class).toMatchObject({
      layout: 'elk',
      nodeSpacing: 40,
      rankSpacing: 52,
      diagramPadding: 12,
    })
    expect(config.state).toMatchObject({
      layout: 'elk',
      nodeSpacing: 40,
      rankSpacing: 52,
      diagramPadding: 12,
    })
    expect(config.themeVariables).toMatchObject({
      primaryColor: TOKENS.surface,
      primaryBorderColor: TOKENS.text2,
      lineColor: TOKENS.text2,
      nodeBorder: TOKENS.text2,
      clusterBkg: TOKENS.surface2,
      clusterBorder: TOKENS.text3,
    })
  })

  it('reproduces the legacy preset when disabled', () => {
    const config = buildMermaidConfig('dark', TOKENS, false)
    expect(config.look).toBeUndefined()
    expect(config.layout).toBeUndefined()
    expect(config.fontSize).toBeUndefined()
    expect(config.darkMode).toBe(true)
    expect(config.flowchart).toMatchObject({
      curve: 'basis',
      nodeSpacing: 40,
      rankSpacing: 48,
      padding: 12,
    })
    expect(config.flowchart?.diagramPadding).toBeUndefined()
    expect(config.sequence).toMatchObject({
      actorMargin: 36,
      diagramMarginX: 12,
      diagramMarginY: 12,
      wrap: true,
    })
    expect(config.themeVariables).toMatchObject({
      primaryColor: TOKENS.surface2,
      primaryBorderColor: TOKENS.text3,
      mainBkg: TOKENS.surface2,
      nodeBorder: TOKENS.text3,
      clusterBorder: TOKENS.border,
    })
  })

  it('keeps strict security settings in both modes', () => {
    for (const enhance of [true, false]) {
      const config = buildMermaidConfig('light', TOKENS, enhance)
      expect(config.securityLevel).toBe('strict')
      expect(config.suppressErrorRendering).toBe(true)
      expect(config.startOnLoad).toBe(false)
    }
  })
})

describe('renderMermaid', () => {
  it('returns a friendly error for empty diagrams without loading the engine', async () => {
    await expect(renderMermaid('   ', 'light', true)).resolves.toEqual({
      error: '图表内容为空',
    })
  })
})

describe('describeMermaidError', () => {
  it('extracts messages from errors and raw values', () => {
    expect(describeMermaidError(new Error('bad syntax'))).toBe('bad syntax')
    expect(describeMermaidError('bad syntax')).toBe('bad syntax')
  })
})
