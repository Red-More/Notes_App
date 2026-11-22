//! Agent 正文（text part）的 Markdown 渲染管线。
//!
//! chatView 已按 part.type 分流：文本/思考投影成 Bubble，工具调用与结果投影
//! 成独立 ToolCard。这里只接收 `Bubble.text`；tool_* 区块永远走 ToolCardView，
//! 两条渲染管线不混染。

import { useEffect, useMemo, useRef } from 'react'
import 'katex/dist/katex.min.css'
import { renderMarkdownPreview } from '../../editor/markdown'
import { useMarkdownDisplay } from '../../editor/markdownPrefs'
import { classifyHref } from '../../editor/links'
import { openExternal } from '../../system/openExternal'
import { requestImageZoom } from '../../system/imageZoom'
import { copyText } from '../../system/clipboard'
import { toast } from '../../toast'

interface Props {
  text: string
}

/** Mouse travel, in px, before a press on a wide table becomes a pan. */
const DRAG_SLOP = 4

/**
 * Mark one wide table with its scroll state: `is-scrollable` for overflowing
 * tables, `at-start` / `at-end` for the ends, so CSS only fades the side that
 * still hides columns.
 */
function syncTableHint(table: HTMLElement): void {
  const max = table.scrollWidth - table.clientWidth
  table.classList.toggle('is-scrollable', max > 1)
  table.classList.toggle('at-start', table.scrollLeft <= 1)
  table.classList.toggle('at-end', table.scrollLeft >= max - 1)
}

export default function ChatMarkdown({ text }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  // Timestamp until which a click is the leftover of a table pan, not a tap.
  const muteClickUntil = useRef(0)
  const display = useMarkdownDisplay()
  // Raw HTML follows the shared display setting; the renderer sanitizes every
  // raw fragment, so model output can never introduce executable markup.
  const html = useMemo(() => renderMarkdownPreview(text, display), [text, display])

  // The edge-fade classes live on the generated HTML, so they are re-attached
  // whenever the rendered document changes (streaming included).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const teardown: Array<() => void> = []
    root.querySelectorAll<HTMLElement>('.table-scroll').forEach((table) => {
      const update = () => syncTableHint(table)
      update()
      table.addEventListener('scroll', update, { passive: true })
      // Rotation or a font-scale change resizes the table without new HTML.
      const observer = new ResizeObserver(update)
      observer.observe(table)
      teardown.push(() => {
        table.removeEventListener('scroll', update)
        observer.disconnect()
      })
    })
    return () => teardown.forEach((dispose) => dispose())
  }, [html])

  // Desktop pointer drag panning for wide tables. Touch and trackpad keep their
  // native scrolling; only a primary mouse button press is turned into a pan.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let drag: {
      table: HTMLElement
      pointerId: number
      startX: number
      startLeft: number
      moved: boolean
    } | null = null

    // A pan that actually moved must not also fire the click on its release.
    const finish = () => {
      if (!drag) return
      drag.table.classList.remove('is-dragging')
      if (drag.moved) muteClickUntil.current = performance.now() + 300
      drag = null
    }

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0) return
      const table = (event.target as Element).closest<HTMLElement>('.table-scroll')
      if (!table || table.scrollWidth <= table.clientWidth + 1) return
      drag = {
        table,
        pointerId: event.pointerId,
        startX: event.clientX,
        startLeft: table.scrollLeft,
        moved: false,
      }
      drag.table.classList.add('is-dragging')
    }

    const onPointerMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      const dx = event.clientX - drag.startX
      if (!drag.moved) {
        if (Math.abs(dx) < DRAG_SLOP) return
        drag.moved = true
      }
      drag.table.scrollLeft = drag.startLeft - dx
    }

    root.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      finish()
      root.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [])

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement

    // A mouse pan just ended over this spot: swallow the synthetic click.
    if (performance.now() < muteClickUntil.current) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    // A tapped picture opens the viewer instead of navigating the webview.
    const image = target.closest<HTMLImageElement>('img')
    if (image) {
      event.preventDefault()
      const src = image.currentSrc || image.src
      if (src) requestImageZoom({ src, alt: image.alt })
      return
    }

    const link = target.closest<HTMLAnchorElement>('a')
    if (!link) return
    const linkTarget = classifyHref(link.getAttribute('href') ?? '', link.href)
    if (!linkTarget) {
      event.preventDefault()
      return
    }
    // In-page anchors (footnotes) keep their default navigation.
    if (linkTarget.internal) return
    event.preventDefault()
    if (linkTarget.openable) {
      void openExternal(linkTarget.address).then((ok) => {
        if (!ok) toast('无法打开链接')
      })
      return
    }
    void copyText(linkTarget.address).then((ok) => {
      toast(ok ? '链接已复制' : '无法复制链接')
    })
  }

  return (
    <div
      ref={rootRef}
      className="md-preview chat-markdown"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
