import {
  forwardRef,
  useDeferredValue,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react'
import { renderMarkdownPreview } from '../editor/markdown'
import { lineAtOffset, offsetForLine, type PreviewBlock } from '../editor/sync'
import { toast } from '../toast'

export interface MarkdownPreviewHandle {
  /** Scroll the preview to the block containing a source line. */
  scrollToLine: (line: number) => void
  /** 1-based source line at the top of the preview viewport. */
  getTopLine: () => number
}

interface MarkdownPreviewProps {
  source: string
  onScrollLine: (line: number) => void
  onSourceLine: (line: number) => void
}

export const MarkdownPreview = forwardRef<MarkdownPreviewHandle, MarkdownPreviewProps>(
  function MarkdownPreview({ source, onScrollLine, onSourceLine }, ref) {
    const scrollRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const blocksRef = useRef<PreviewBlock[]>([])
    const frameRef = useRef(0)
    const onScrollRef = useRef(onScrollLine)
    const onSourceRef = useRef(onSourceLine)

    // Rendering is deferred so typing stays responsive on low-end phones.
    const deferredSource = useDeferredValue(source)
    const html = useMemo(() => renderMarkdownPreview(deferredSource), [deferredSource])

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

      // Never let an external link navigate the app webview away; copy it
      // instead so it can be opened in a real browser.
      const link = target.closest<HTMLAnchorElement>('a')
      if (link) {
        event.preventDefault()
        const href = link.href
        if (!/^https?:/i.test(href)) return
        const clipboard = navigator.clipboard
        if (!clipboard) {
          toast('当前环境无法复制链接')
          return
        }
        void clipboard
          .writeText(href)
          .then(() => toast('链接已复制，请在浏览器打开'))
          .catch(() => toast('无法复制链接'))
        return
      }

      // Checkboxes keep their own behavior.
      if (target.closest('input, button')) return
      const block = target.closest<HTMLElement>('[data-line]')
      if (!block) return
      const line = Number(block.dataset.line)
      if (Number.isFinite(line) && line > 0) onSourceRef.current(line)
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
      </div>
    )
  },
)
