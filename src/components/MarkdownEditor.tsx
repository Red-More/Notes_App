import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { EditorState, Prec, RangeSetBuilder } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
  rectangularSelection,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { highlightSelectionMatches } from '@codemirror/search'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands'
import {
  HighlightStyle,
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete'
import { linter } from '@codemirror/lint'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { tags } from '@lezer/highlight'
import { findUnclosedFence } from '../editor/diagnostics'
import { insertMarkdownLink, toggleInlineMarker } from '../editor/commands'
import { indentUnitFor, type EditorPrefs } from '../editor/prefs'
import { assetDataUrl } from '../assets'
import { requestImageZoom } from '../system/imageZoom'
import {
  clipboardImageFromNative,
  hasTextPayload,
  imageFilesFromTransfer,
} from '../system/clipboardImages'

export interface MarkdownEditorHandle {
  focus: () => void
  blur: () => void
  undo: () => void
  redo: () => void
  /** Scroll the source to a line without moving the selection. */
  scrollToLine: (line: number) => void
  /** Move the selection to a line and center it (preview click-to-source). */
  revealLine: (line: number) => void
  /** Insert text at the caret (used by image insertion) and keep focus. */
  insertAtCursor: (text: string, caretOffset?: number) => void
  /** Wrap or unwrap the selection with an inline marker (quick bar). */
  toggleInline: (marker: string) => void
  /** Insert a Markdown link around the selection (quick bar). */
  insertLink: () => void
  /** Toggle a line prefix such as `# `, `- ` or `> ` on the selected lines. */
  toggleLinePrefix: (prefix: string) => void
  /** 1-based line at the top of the editor viewport. */
  getTopLine: () => number
}

interface MarkdownEditorProps {
  value: string
  prefs: EditorPrefs
  kbInset: number
  onChange: (value: string) => void
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void
  onScrollLine: (line: number) => void
  onPasteImages: (files: File[]) => void
}

type CallbackRef<T> = { current: T }

interface EditorRefs {
  onChange: CallbackRef<(value: string) => void>
  onHistory: CallbackRef<(canUndo: boolean, canRedo: boolean) => void>
  onScroll: CallbackRef<(line: number) => void>
  onPasteImages: CallbackRef<(files: File[]) => void>
  history: CallbackRef<{ undo: number; redo: number }>
}

/** Markdown-aware theme using the app's design tokens, so dark mode follows. */
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '15px',
    color: 'var(--text)',
    backgroundColor: 'transparent',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'PingFang SC', monospace",
    lineHeight: '1.75',
    overflow: 'auto',
    overscrollBehavior: 'contain',
    padding: '4px 0 12px',
  },
  '.cm-content': { padding: '0 4px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 6px' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'var(--text-3)',
    minWidth: '34px',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 8px 0 4px',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
  '.cm-activeLine': { backgroundColor: 'var(--surface-2)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--accent-weak)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-border)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-placeholder': { color: 'var(--text-3)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    boxShadow: 'var(--shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--sans)', fontSize: '13px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '6px 10px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-weak)',
    color: 'var(--text)',
  },
  '.cm-completionLabel': { fontWeight: '600' },
  '.cm-completionDetail': { color: 'var(--text-2)', fontStyle: 'normal' },
  '.cm-lintRange-warning': { textDecoration: 'underline wavy var(--accent)' },
})

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--accent-deep)', fontWeight: '700' },
  { tag: [tags.heading2, tags.heading3], color: 'var(--text)', fontWeight: '700' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--text)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--info)' },
  { tag: tags.url, color: 'var(--info)' },
  { tag: tags.monospace, color: 'var(--accent-deep)' },
  { tag: tags.quote, color: 'var(--text-2)' },
  {
    tag: [tags.processingInstruction, tags.contentSeparator, tags.punctuation],
    color: 'var(--text-3)',
  },
  { tag: tags.list, color: 'var(--accent)' },
])

const HEADING_COMPLETIONS: Completion[] = [
  { label: '一级标题', apply: '# ', type: 'keyword' },
  { label: '二级标题', apply: '## ', type: 'keyword' },
  { label: '三级标题', apply: '### ', type: 'keyword' },
  { label: '四级标题', apply: '#### ', type: 'keyword' },
]

const LIST_COMPLETIONS: Completion[] = [
  { label: '无序列表', apply: '- ', type: 'keyword' },
  { label: '任务列表', apply: '- [ ] ', type: 'keyword' },
  { label: '有序列表', apply: '1. ', type: 'keyword' },
]

const QUOTE_COMPLETIONS: Completion[] = [{ label: '引用', apply: '> ', type: 'keyword' }]

const EXTRA_COMPLETIONS: Completion[] = [
  {
    label: '代码块',
    type: 'keyword',
    apply: (view, _completion, from, to) => {
      view.dispatch({
        changes: { from, to, insert: '```\n\n```' },
        selection: { anchor: from + 4 },
        userEvent: 'input.complete',
      })
    },
  },
  { label: '表格', apply: '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |', type: 'keyword' },
  { label: '加粗', apply: '**加粗**', type: 'keyword' },
  { label: '链接', apply: '[链接文字](url)', type: 'keyword' },
]

const ALL_COMPLETIONS: Completion[] = [
  ...HEADING_COMPLETIONS,
  ...LIST_COMPLETIONS,
  ...QUOTE_COMPLETIONS,
  ...EXTRA_COMPLETIONS,
]

/**
 * Suggestions appear when a line starts with a markdown marker (`#`, list
 * bullet, quote) or on explicit request (Ctrl+Space on a hardware keyboard).
 */
function markdownCompletions(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  const before = context.state.sliceDoc(line.from, context.pos)
  const trigger = before.trim()

  let options: Completion[]
  if (context.explicit) {
    options = ALL_COMPLETIONS
  } else if (/^#{1,6}$/.test(trigger)) {
    options = HEADING_COMPLETIONS
  } else if (/^[-*+]$/.test(trigger)) {
    options = [...LIST_COMPLETIONS, ...QUOTE_COMPLETIONS]
  } else if (trigger === '>') {
    options = QUOTE_COMPLETIONS
  } else {
    return null
  }

  const from = context.explicit
    ? context.pos
    : line.from + before.length - before.trimStart().length
  return { from, options, validFor: /^[#>*+\-\s]*$/ }
}

function topLineOf(view: EditorView): number {
  // The note editor reserves a top inset for its collapsing metadata head.
  // The height map ignores that inset, so subtract it to report the real line.
  const inset = Number.parseFloat(view.scrollDOM.style.paddingTop) || 0
  const top = Math.max(0, view.scrollDOM.scrollTop - inset)
  const block = view.lineBlockAtHeight(top)
  return view.state.doc.lineAt(block.from).number
}

function linePosition(view: EditorView, line: number): number {
  const clamped = Math.max(1, Math.min(view.state.doc.lines, Math.round(line)))
  return view.state.doc.line(clamped).from
}

/**
 * Toggle `prefix` at the start of every selected line. Collapsed selections
 * act on the current line; a selection ending exactly at a line start does not
 * include that line.
 */
function toggleLinePrefix(view: EditorView, prefix: string): void {
  const { state } = view
  const selection = state.selection.main
  const firstNumber = state.doc.lineAt(selection.from).number
  let lastNumber = state.doc.lineAt(selection.to).number
  if (selection.to === state.doc.line(lastNumber).from && lastNumber > firstNumber) {
    lastNumber -= 1
  }
  const numbers: number[] = []
  for (let number = firstNumber; number <= lastNumber; number += 1) numbers.push(number)

  const allPrefixed = numbers.every((number) => state.doc.line(number).text.startsWith(prefix))
  const changes = numbers.map((number) => {
    const line = state.doc.line(number)
    return allPrefixed
      ? { from: line.from, to: line.from + prefix.length, insert: '' }
      : { from: line.from, insert: prefix }
  })
  view.dispatch({ changes, userEvent: 'input.format' })
  view.focus()
}

/**
 * Renders `![alt](asset:<id>)` as an inline picture while keeping the Markdown
 * source untouched. Clicking the picture selects the exact source range so the
 * user can delete it, and double-clicking opens the enlarged viewer; cursor
 * movement, selection and history stay native.
 */
const ASSET_IMAGE_RE = /!\[([^\]]*)\]\(asset:(\d+)\)/g

class AssetImageWidget extends WidgetType {
  readonly id: number
  readonly alt: string
  readonly from: number
  readonly to: number

  constructor(id: number, alt: string, from: number, to: number) {
    super()
    this.id = id
    this.alt = alt
    this.from = from
    this.to = to
  }

  eq(other: AssetImageWidget): boolean {
    return (
      other.id === this.id &&
      other.alt === this.alt &&
      other.from === this.from &&
      other.to === this.to
    )
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-asset-image'
    wrap.title = '单击选中源码，双击放大'
    const image = document.createElement('img')
    image.alt = this.alt || '图片'
    image.loading = 'lazy'
    image.addEventListener('mousedown', (event) => {
      event.preventDefault()
      view.dispatch({ selection: { anchor: this.from, head: this.to } })
      view.focus()
    })
    // The source URL is resolved asynchronously, so keep it for the zoom event.
    let zoomSrc: string | null = null
    image.addEventListener('dblclick', (event) => {
      event.preventDefault()
      if (zoomSrc) requestImageZoom({ src: zoomSrc, alt: this.alt })
    })
    void assetDataUrl(this.id).then((url) => {
      if (!wrap.isConnected) return
      if (url) {
        image.src = url
        zoomSrc = url
      } else {
        wrap.classList.add('asset-missing')
        wrap.textContent = '图片缺失'
      }
    })
    wrap.appendChild(image)
    return wrap
  }
}

type SyntaxNodeLike = { name: string; parent: SyntaxNodeLike | null }

/** Skip image syntax that sits inside code, where it is literal text. */
function insideCode(state: EditorState, pos: number): boolean {
  let node: SyntaxNodeLike | null = syntaxTree(state).resolveInner(pos, 1)
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
      return true
    }
    node = node.parent
  }
  return false
}

function buildAssetDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  let coveredUntil = 0
  for (const range of view.visibleRanges) {
    let pos = range.from
    while (pos <= range.to) {
      const line = view.state.doc.lineAt(pos)
      for (const match of line.text.matchAll(ASSET_IMAGE_RE)) {
        const start = line.from + (match.index ?? 0)
        const end = start + match[0].length
        // Visible ranges can overlap at a line boundary; never add twice.
        if (start < coveredUntil || insideCode(view.state, start)) continue
        builder.add(
          start,
          end,
          Decoration.replace({
            widget: new AssetImageWidget(Number(match[2]), match[1], start, end),
          }),
        )
        coveredUntil = end
      }
      if (line.to >= range.to) break
      pos = line.to + 1
    }
  }
  return builder.finish()
}

const assetImagePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildAssetDecorations(view)
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildAssetDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

function buildExtensions(prefs: EditorPrefs, refs: EditorRefs) {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(markdownHighlightStyle),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [markdownCompletions] }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...closeBracketsKeymap, ...historyKeymap, ...completionKeymap, ...defaultKeymap]),
    Prec.high(
      keymap.of([
        { key: 'Mod-b', run: toggleInlineMarker('**') },
        { key: 'Mod-i', run: toggleInlineMarker('*') },
        { key: 'Mod-e', run: toggleInlineMarker('`') },
        { key: 'Mod-k', run: insertMarkdownLink },
        indentWithTab,
      ]),
    ),
    markdown({ codeLanguages: languages }),
    assetImagePlugin,
    // Pictures arrive as files on desktop and as base64 <img> markup on some
    // mobile WebViews; the Android shell covers clips the page cannot read.
    EditorView.domEventHandlers({
      paste: (event) => {
        const files = imageFilesFromTransfer(event.clipboardData)
        if (files.length > 0) {
          event.preventDefault()
          refs.onPasteImages.current(files)
          return true
        }
        // Text pastes keep their default behavior, so the native clipboard is
        // only consulted when the transfer carried nothing pasteable.
        if (hasTextPayload(event.clipboardData)) return false
        const image = clipboardImageFromNative()
        if (!image) return false
        event.preventDefault()
        refs.onPasteImages.current([image])
        return true
      },
      // Mobile IMEs may deliver the picture through beforeinput only, with the
      // paste event suppressed entirely.
      beforeinput: (event) => {
        if (event.inputType !== 'insertFromPaste' && event.inputType !== 'insertFromDrop') {
          return false
        }
        const files = imageFilesFromTransfer(event.dataTransfer)
        if (files.length === 0) return false
        event.preventDefault()
        refs.onPasteImages.current(files)
        return true
      },
    }),
    indentationMarkers({
      thickness: 1,
      activeThickness: 2,
      highlightActiveBlock: true,
      markerType: 'fullScope',
      colors: {
        light: 'var(--border)',
        activeLight: 'var(--accent-border)',
        dark: 'var(--border)',
        activeDark: 'var(--accent-border)',
      },
    }),
    linter((view) => findUnclosedFence(view.state), { delay: 400 }),
    indentUnit.of(indentUnitFor(prefs)),
    EditorState.tabSize.of(prefs.indentSize),
    // The note editor reserves a top inset for its collapsible metadata head.
    // A vertical cursor margin would scroll "above" the first line when the
    // caret sits at the viewport top, which pulls that head open and makes the
    // whole page jitter on every IME-triggered reveal. Keep the top margin at 0.
    EditorView.cursorScrollMargin.of({ x: 5, y: 0 }),
    EditorView.lineWrapping,
    editorTheme,
    placeholder('开始记录…'),
    EditorView.contentAttributes.of({
      'aria-label': '笔记正文',
      autocapitalize: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) refs.onChange.current(update.state.doc.toString())
      const undoCount = undoDepth(update.state)
      const redoCount = redoDepth(update.state)
      const previous = refs.history.current
      if (undoCount !== previous.undo || redoCount !== previous.redo) {
        refs.history.current = { undo: undoCount, redo: redoCount }
        refs.onHistory.current(undoCount > 0, redoCount > 0)
      }
    }),
  ]
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    { value, prefs, kbInset, onChange, onHistoryChange, onScrollLine, onPasteImages },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const valueRef = useRef(value)
    const onChangeRef = useRef(onChange)
    const onHistoryRef = useRef(onHistoryChange)
    const onScrollRef = useRef(onScrollLine)
    const onPasteImagesRef = useRef(onPasteImages)
    const historyRef = useRef({ undo: -1, redo: -1 })

    useEffect(() => {
      valueRef.current = value
    }, [value])

    useEffect(() => {
      onChangeRef.current = onChange
    }, [onChange])

    useEffect(() => {
      onHistoryRef.current = onHistoryChange
    }, [onHistoryChange])

    useEffect(() => {
      onScrollRef.current = onScrollLine
    }, [onScrollLine])

    useEffect(() => {
      onPasteImagesRef.current = onPasteImages
    }, [onPasteImages])

    // Create the view once per editor session; prefs are read per session.
    useEffect(() => {
      const host = hostRef.current
      if (!host) return
      const extensions = buildExtensions(prefs, {
        onChange: onChangeRef,
        onHistory: onHistoryRef,
        onScroll: onScrollRef,
        onPasteImages: onPasteImagesRef,
        history: historyRef,
      })
      const state = EditorState.create({ doc: valueRef.current, extensions })
      const view = new EditorView({ state, parent: host })
      viewRef.current = view
      historyRef.current = { undo: undoDepth(state), redo: redoDepth(state) }
      onHistoryRef.current(false, false)

      // Scroll events do not bubble from CodeMirror's scroller, so listen on it
      // directly. Report only line changes: preview sync is line-granular.
      let lastScrollLine = topLineOf(view)
      const onScroll = () => {
        const line = topLineOf(view)
        if (line !== lastScrollLine) {
          lastScrollLine = line
          onScrollRef.current(line)
        }
      }
      view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

      return () => {
        view.scrollDOM.removeEventListener('scroll', onScroll)
        view.destroy()
        viewRef.current = null
      }
    }, [prefs])

    // External changes (note load, version restore) reset the doc and history.
    useEffect(() => {
      const view = viewRef.current
      if (!view || view.state.doc.toString() === value) return
      const extensions = buildExtensions(prefs, {
        onChange: onChangeRef,
        onHistory: onHistoryRef,
        onScroll: onScrollRef,
        onPasteImages: onPasteImagesRef,
        history: historyRef,
      })
      view.setState(EditorState.create({ doc: value, extensions }))
      historyRef.current = { undo: 0, redo: 0 }
      onHistoryRef.current(false, false)
    }, [value, prefs])

    // Keep the caret visible when the soft keyboard changes the viewport.
    // No top margin: with the editor's reserved top inset, any upward scroll
    // would be consumed by the collapsing metadata head and shift the whole
    // page down before snapping back.
    useEffect(() => {
      const view = viewRef.current
      if (!view || kbInset <= 0 || !view.hasFocus) return
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, {
          y: 'nearest',
          yMargin: 0,
        }),
      })
    }, [kbInset])

    useImperativeHandle(
      ref,
      () => ({
        focus: () => viewRef.current?.focus(),
        blur: () => viewRef.current?.contentDOM.blur(),
        undo: () => {
          const view = viewRef.current
          if (view) undo(view)
        },
        redo: () => {
          const view = viewRef.current
          if (view) redo(view)
        },
        scrollToLine: (line) => {
          const view = viewRef.current
          if (!view) return
          view.dispatch({
            effects: EditorView.scrollIntoView(linePosition(view, line), {
              y: 'start',
              // Align the line with the viewport top; a margin would eat into
              // the reserved metadata-head inset and expand it.
              yMargin: 0,
            }),
          })
        },
        revealLine: (line) => {
          const view = viewRef.current
          if (!view) return
          const pos = linePosition(view, line)
          view.dispatch({
            selection: { anchor: pos },
            effects: EditorView.scrollIntoView(pos, { y: 'center' }),
          })
        },
        insertAtCursor: (text, caretOffset) => {
          const view = viewRef.current
          if (!view) return
          const { from, to } = view.state.selection.main
          const caret = from + (caretOffset ?? text.length)
          view.dispatch({
            changes: { from, to, insert: text },
            selection: { anchor: caret },
            // Keep the same no-top-margin rule as the other reveal paths.
            effects: EditorView.scrollIntoView(caret, { y: 'nearest', yMargin: 0 }),
          })
          view.focus()
        },
        toggleInline: (marker) => {
          const view = viewRef.current
          if (view) toggleInlineMarker(marker)(view)
        },
        insertLink: () => {
          const view = viewRef.current
          if (view) insertMarkdownLink(view)
        },
        toggleLinePrefix: (prefix) => {
          const view = viewRef.current
          if (view) toggleLinePrefix(view, prefix)
        },
        getTopLine: () => {
          const view = viewRef.current
          return view ? topLineOf(view) : 1
        },
      }),
      [],
    )

    return <div className="markdown-editor" ref={hostRef} />
  },
)
