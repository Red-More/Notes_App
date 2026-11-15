//! Agent 正文（text part）的 Markdown 渲染管线。
//!
//! chatView 已按 part.type 分流：文本/思考投影成 Bubble，工具调用与结果投影
//! 成独立 ToolCard。这里只接收 `Bubble.text`；tool_* 区块永远走 ToolCardView，
//! 两条渲染管线不混染。

import { useMemo } from 'react'
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

export default function ChatMarkdown({ text }: Props) {
  const display = useMarkdownDisplay()
  // Raw HTML follows the shared display setting; the renderer sanitizes every
  // raw fragment, so model output can never introduce executable markup.
  const html = useMemo(() => renderMarkdownPreview(text, display), [text, display])

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement

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
      className="md-preview chat-markdown"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
