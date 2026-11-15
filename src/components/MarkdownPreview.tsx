import {
  forwardRef,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import 'katex/dist/katex.min.css'
import {
  applyCachedMermaid,
  currentMermaidTheme,
  renderMermaidBlock,
  type MermaidTheme,
} from '../editor/mermaid'
import { renderMarkdownPreview } from '../editor/markdown'
import { useMarkdownDisplay } from '../editor/markdownPrefs'
import { resolveAssetImages } from '../assets'
import { classifyHref } from '../editor/links'
import { lineAtOffset, offsetForLine, type PreviewBlock } from '../editor/sync'
import { copyText } from '../system/clipboard'
import { openExternal } from '../system/openExternal'
import { requestImageZoom } from '../system/imageZoom'
import { toast } from '../toast'
import { ConfirmDialog } from './ui'
import { IconExternalLink } from './Icons'

export interface MarkdownPreviewHandle {
  /** Scroll the preview to the block containing a source line. */
  scrollToLine: (line: number) => void
  /** 1-based source line at the top of the preview viewport. */
  getTopLine: () => number
}

interface MarkdownPreviewProps {
  source: string
  /** Whether to render diagrams with the enhanced visual preset. */
  enhance: boolean
  onScrollLine: (line: number) => void
  onSourceLine: (line: number) => void
}

/** Compact host label shown above the full address in the confirm card. */
function hostLabel(address: string): string {
  try {
    const url = new URL(address)
    if (url.protocol === 'mailto:') return '邮件链接'
    if (url.protocol === 'tel:') return '电话链接'
    return url.hostname || address
  } catch {
    return address
  }
}

export const MarkdownPreview = forwardRef<MarkdownPreviewHandle, MarkdownPreviewProps>(
  function MarkdownPreview({ source, enhance, onScrollLine, onSourceLine }, ref) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const blocksRef = useRef<PreviewBlock[]>([])
    const frameRef = useRef(0)
    const onScrollRef = useRef(onScrollLine)
    const onSourceRef = useRef(onSourceLine)
    const [pendingLink, setPendingLink] = useState<string | null>(null)

    // Rendering is deferred so typing stays responsive on low-end phones.
    const deferredSource = useDeferredValue(source)
    const display = useMarkdownDisplay()
    const html = useMemo(
      () => renderMarkdownPreview(deferredSource, display),
      [deferredSource, display],
    )
    // The app theme lives on <html data-theme>, outside React. Observe it so
    // diagrams re-render with the matching Mermaid theme while the pane stays
    // mounted (e.g. OS light/dark changes in "system" mode).
    const [theme, setTheme] = useState<MermaidTheme>(() => currentMermaidTheme())

    useEffect(() => {
      const observer = new MutationObserver(() => {
        const next = currentMermaidTheme()
        setTheme((previous) => (previous === next ? previous : next))
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-theme'],
      })
      return () => observer.disconnect()
    }, [])

    useEffect(() => {
      onScrollRef.current = onScrollLine
    }, [onScrollLine])

    useEffect(() => {
      onSourceRef.current = onSourceLine
    }, [onSourceLine])

    const measure = () => {
      const scroller = scrollRef.current
      if (!scroller) {
        blocksRef.current = []
        return
      }
      const blocks: PreviewBlock[] = []
      scroller.querySelectorAll<HTMLElement>('[data-line]').forEach((element) => {
        const line = Number(element.dataset.line)
        // Offsets only make sense for elements positioned by the scroller;
        // table rows/cells use the table as their offsetParent.
        if (
          !Number.isFinite(line) ||
          line <= 0 ||
          element.offsetHeight <= 0 ||
          element.offsetParent !== scroller
        ) {
          return
        }
        blocks.push({ line, top: element.offsetTop, height: element.offsetHeight })
      })
      blocks.sort((a, b) => a.top - b.top)
      blocksRef.current = blocks
    }

    // Mermaid renders after the HTML is committed. Cached SVGs are applied
    // synchronously so they are measured/painted immediately; uncached diagrams
    // load the engine lazily and degrade to a readable error on failure.
    useLayoutEffect(() => {
      const content = contentRef.current
      if (!content) return
      const blocks = content.querySelectorAll<HTMLElement>('.mermaid-block')
      if (blocks.length === 0) return

      const pending: Array<{ block: HTMLElement; source: string }> = []
      blocks.forEach((block) => {
        // Prefer the wrapper attribute: the inner source placeholder is gone
        // after the first render, and React can reuse this wrapper on re-render.
        let source = ''
        const encoded = block.dataset.mermaidSource
        if (encoded) {
          try {
            source = decodeURIComponent(encoded)
          } catch {
            source = encoded
          }
        }
        if (!source) {
          source = block.querySelector('.mermaid-source')?.textContent ?? ''
        }
        if (!applyCachedMermaid(block, source, theme, enhance)) {
          pending.push({ block, source })
        }
      })
      if (pending.length === 0) return

      let cancelled = false
      void (async () => {
        for (const item of pending) {
          if (cancelled) return
          await renderMermaidBlock(item.block, item.source, theme, enhance)
        }
      })()
      return () => {
        cancelled = true
      }
    }, [html, enhance, theme])

    // Notes reference images as `asset:<id>`; swap in data URLs after commit.
    useLayoutEffect(() => {
      const content = contentRef.current
      if (!content) return
      resolveAssetImages(content)
    }, [html])

    // Re-measure after every HTML change; block positions drive scroll sync.
    useLayoutEffect(() => {
      measure()
      const scroller = scrollRef.current
      const content = contentRef.current
      if (!scroller || !content) return
      const observer = new ResizeObserver(() => measure())
      observer.observe(scroller)
      observer.observe(content)
      return () => observer.disconnect()
    }, [html])

    useEffect(
      () => () => {
        if (frameRef.current) cancelAnimationFrame(frameRef.current)
      },
      [],
    )

    const handleScroll = () => {
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0
        const scroller = scrollRef.current
        if (!scroller) return
        const line = lineAtOffset(blocksRef.current, scroller.scrollTop)
        if (line != null) onScrollRef.current(line)
      })
    }

    useImperativeHandle(
      ref,
      () => ({
        scrollToLine: (line) => {
          const scroller = scrollRef.current
          if (!scroller) return
          const offset = offsetForLine(blocksRef.current, line)
          if (offset != null) scroller.scrollTop = offset
        },
        getTopLine: () => {
          const scroller = scrollRef.current
          if (!scroller) return 1
          return lineAtOffset(blocksRef.current, scroller.scrollTop) ?? 1
        },
      }),
      [],
    )

    const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement

      // A tapped picture opens the enlarged viewer. This wins over a link
      // wrapping the image, which would otherwise navigate the webview.
      const image = target.closest<HTMLImageElement>('img')
      if (image) {
        event.preventDefault()
        const src = image.currentSrc || image.src
        if (src) requestImageZoom({ src, alt: image.alt })
        return
      }

      const link = target.closest<HTMLAnchorElement>('a')

      // Never let a link navigate the app webview away. In-page anchors
      // (footnotes) keep their default navigation.
      if (link) {
        const linkTarget = classifyHref(
          link.getAttribute('href') ?? '',
          link.href,
        )
        if (!linkTarget) {
          event.preventDefault()
          return
        }
        if (linkTarget.internal) return
        event.preventDefault()

        // Openable links ask for confirmation; declining copies the address.
        if (linkTarget.openable) {
          setPendingLink(linkTarget.address)
          return
        }

        // Relative/custom links cannot be opened by the system browser.
        void copyText(linkTarget.address).then((ok) => {
          toast(ok ? '链接已复制' : '无法复制链接')
        })
        return
      }

      // Checkboxes keep their own behavior.
      if (target.closest('input, button')) return
      const block = target.closest<HTMLElement>('[data-line]')
      if (!block) return
      const line = Number(block.dataset.line)
      if (Number.isFinite(line) && line > 0) onSourceRef.current(line)
    }

    const handleConfirmOpen = () => {
      const address = pendingLink
      setPendingLink(null)
      if (!address) return
      void openExternal(address).then((ok) => {
        if (ok) return
        // Opening failed (permissions, no handler): keep the link accessible.
        void copyText(address).then((copied) => {
          toast(copied ? '无法打开浏览器，链接已复制' : '无法打开浏览器')
        })
      })
    }

    const handleDeclineOpen = () => {
      const address = pendingLink
      setPendingLink(null)
      if (!address) return
      void copyText(address).then((ok) => {
        toast(ok ? '链接已复制' : '无法复制链接')
      })
    }

    return (
      <div className="preview-scroll" ref={scrollRef} onScroll={handleScroll}>
        {html ? (
          <div
            ref={contentRef}
            className="md-preview"
            onClick={handleClick}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="preview-empty">（无内容）</div>
        )}
        {pendingLink ? (
          <ConfirmDialog
            title="打开链接"
            message="将在系统应用中打开此链接"
            icon={<IconExternalLink size={17} />}
            detail={
              <>
                <span className="dialog-detail-host">{hostLabel(pendingLink)}</span>
                <span className="dialog-detail-url">{pendingLink}</span>
              </>
            }
            confirmText="打开"
            cancelText="复制链接"
            onConfirm={handleConfirmOpen}
            onCancel={handleDeclineOpen}
          />
        ) : null}
      </div>
    )
  },
)
