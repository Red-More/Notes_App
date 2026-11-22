import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react'
import { Compartment, EditorState, Prec, RangeSetBuilder } from '@codemirror/state'
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
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { indentationMarkers } from '@replit/codemirror-indentation-markers'
import { tags, type Tag } from '@lezer/highlight'
import { findUnclosedFence } from '../editor/diagnostics'
import {
  cycleHeadingRange,
  insertMarkdownLink,
  toggleInlineMarker,
  toggleLinePrefixRange,
} from '../editor/commands'
import { indentUnitFor, type EditorPrefs } from '../editor/prefs'
import {
  SYNTAX_TOKENS,
  getSyntaxPrefs,
  resolveSyntaxColor,
  subscribeSyntaxPrefs,
  syntaxColorCss,
  type SyntaxPrefs,
  type SyntaxToken,
} from '../editor/syntaxPrefs'
import { buildMarkerTheme, syntaxMarkPlugin } from '../editor/syntaxMarks'
import { assetDataUrl } from '../assets'
import { requestImageZoom } from '../system/imageZoom'
import { hapticTap } from '../system/haptics'
import { anchorFromCoords, type MenuAnchor, type Point } from '../editor/selectionMenu'
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
  /** Cycle heading levels (H1→…→H6→off) on the selected lines. */
  cycleHeading: () => void
  /** 1-based line at the top of the editor viewport. */
  getTopLine: () => number
  /** Whether the document currently has a non-empty selection. */
  hasSelection: () => boolean
  /** Text of the current selection (empty when nothing is selected). */
  selectionText: () => string
  /** Select the whole document (long-press menu). */
  selectAll: () => void
  /** Delete the selection without touching the clipboard. */
  deleteSelection: () => void
  /**
   * Client rect the text menu should hang off: the selection when there is
   * one, otherwise `press` (the long-press / right-click point).
   */
  selectionAnchor: (press?: Point | null) => MenuAnchor
}

interface MarkdownEditorProps {
  value: string
  prefs: EditorPrefs
  kbInset: number
  onChange: (value: string) => void
  onHistoryChange: (canUndo: boolean, canRedo: boolean) => void
  onScrollLine: (line: number) => void
  onPasteImages: (files: File[]) => void
  /** Long press (or right click) on the text: open the editor action menu. */
  onLongPressText: (press: Point) => void
}

type CallbackRef<T> = { current: T }

/** Hold time before a still press on the text raises the editor menu. */
const LONG_PRESS_MS = 500

interface EditorRefs {
  onChange: CallbackRef<(value: string) => void>
  onHistory: CallbackRef<(canUndo: boolean, canRedo: boolean) => void>
  onScroll: CallbackRef<(line: number) => void>
  onPasteImages: CallbackRef<(files: File[]) => void>
  onLongPressText: CallbackRef<(press: Point) => void>
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
    // Proportional tail below the document: clickable, no line numbers, no syntax.
    padding: '4px 0 18vh',
  },
  '.cm-content': { padding: '0 4px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 6px' },
  // Deeper list / quote markers fade one step at a time.
  '.cm-md-depth-1': { opacity: '1' },
  '.cm-md-depth-2': { opacity: '0.8' },
  '.cm-md-depth-3': { opacity: '0.64' },
  '.cm-md-depth-4': { opacity: '0.52' },
  '.cm-md-depth-5': { opacity: '0.42' },
  '.cm-md-task-done': { opacity: '0.5' },
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
  // The active line paints above CodeMirror's selection layer, so it must stay
  // translucent or the selection on the caret's line becomes invisible.
  '.cm-activeLine': { backgroundColor: 'var(--editor-active-line)' },
  '.cm-selectionBackground': { backgroundColor: 'var(--editor-selection)' },
  // Match the base theme's focused selector so the stronger color wins.
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'var(--editor-selection-strong)',
  },
  // Search matches use an underline instead of a background: an inline
  // background paints above the selection layer and would punch holes in it.
  '.cm-selectionMatch': {
    backgroundColor: 'transparent',
    boxShadow: 'inset 0 -1px 0 var(--accent-border)',
  },
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

/**
 * Lezer tags each configurable token category covers. Ordered / task markers
 * have no matching tag: they are painted by `syntaxMarks.ts` + the marker theme.
 */
const TOKEN_TAGS: Partial<Record<SyntaxToken, Tag | readonly Tag[]>> = {
  heading1: tags.heading1,
  heading2: tags.heading2,
  heading3: tags.heading3,
  heading4: [tags.heading4, tags.heading5, tags.heading6],
  strong: tags.strong,
  emphasis: tags.emphasis,
  strikethrough: tags.strikethrough,
  link: [tags.link, tags.url],
  code: tags.monospace,
  quote: tags.quote,
  // `list` only paints markers through syntaxMarks; leaving tags.list out keeps
  // list item text in the body color so the markers stay legible per depth.
  punctuation: [tags.processingInstruction, tags.contentSeparator, tags.punctuation],
}

/** Weight / decoration that stays fixed while the user tunes colors. */
const TOKEN_BASE_STYLE: Record<
  SyntaxToken,
  { fontWeight?: string; fontStyle?: string; textDecoration?: string }
> = {
  heading1: { fontWeight: '700' },
  heading2: { fontWeight: '700' },
  heading3: { fontWeight: '600' },
  heading4: { fontWeight: '600' },
  strong: { fontWeight: '700' },
  emphasis: { fontStyle: 'italic' },
  strikethrough: { textDecoration: 'line-through' },
  link: { textDecoration: 'underline' },
  code: {},
  quote: { fontStyle: 'italic' },
  list: {},
  ordered: {},
  task: {},
  punctuation: {},
}

/**
 * Build the Markdown highlight style from the persisted palette, per-token
 * overrides and category switches. Disabled categories get no rule at all, so
 * they fall back to the plain text color.
 */
function buildSyntaxHighlight(prefs: SyntaxPrefs) {
  const styles = SYNTAX_TOKENS.filter(
    (token) => !prefs.disabled.includes(token.key) && TOKEN_TAGS[token.key] != null,
  ).map((token) => ({
    tag: TOKEN_TAGS[token.key]!,
    color: syntaxColorCss(resolveSyntaxColor(prefs, token.key)),
    ...TOKEN_BASE_STYLE[token.key],
  }))
  // Marker colors are node-scoped, so they ride along in the same compartment.
  return [syntaxHighlighting(HighlightStyle.define(styles)), buildMarkerTheme(prefs)]
}

/** Swapped at runtime when the syntax preferences change. */
const syntaxHighlightCompartment = new Compartment()

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

/** Toggle `prefix` on the selected lines and keep the caret after the marker. */
function toggleLinePrefix(view: EditorView, prefix: string): void {
  const spec = view.state.changeByRange((range) =>
    toggleLinePrefixRange(view.state, range, prefix),
  )
  view.dispatch(spec, { userEvent: 'input.format' })
  view.focus()
}

/** Cycle ATX heading levels on the selected lines. */
function cycleHeading(view: EditorView): void {
  const spec = view.state.changeByRange((range) => cycleHeadingRange(view.state, range))
  view.dispatch(spec, { userEvent: 'input.format' })
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
    syntaxHighlightCompartment.of(buildSyntaxHighlight(getSyntaxPrefs())),
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
    // The extended base adds GFM (task lists, tables, strikethrough),
    // superscript / subscript and emoji so the editor matches preview syntax.
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    syntaxMarkPlugin,
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
      // A long press on the text raises the editor menu (剪切/复制/粘贴/全选).
      // WebViews show their own native menu here, which is inconsistent across
      // platforms and lacks 全选, so the press is claimed and our menu opens.
      contextmenu: (event) => {
        event.preventDefault()
        refs.onLongPressText.current({ x: event.clientX, y: event.clientY })
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
    { value, prefs, kbInset, onChange, onHistoryChange, onScrollLine, onPasteImages, onLongPressText },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null)
    const viewRef = useRef<EditorView | null>(null)
    const valueRef = useRef(value)
    const onChangeRef = useRef(onChange)
    const onHistoryRef = useRef(onHistoryChange)
    const onScrollRef = useRef(onScrollLine)
    const onPasteImagesRef = useRef(onPasteImages)
    const onLongPressTextRef = useRef(onLongPressText)
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

    useEffect(() => {
      onLongPressTextRef.current = onLongPressText
    }, [onLongPressText])

    // Apply palette / token color / switch changes without recreating the view,
    // so the caret, undo history and scroll position survive.
    useEffect(
      () =>
        subscribeSyntaxPrefs(() => {
          const view = viewRef.current
          if (!view) return
          view.dispatch({
            effects: syntaxHighlightCompartment.reconfigure(
              buildSyntaxHighlight(getSyntaxPrefs()),
            ),
          })
        }),
      [],
    )

    // Create the view once per editor session; prefs are read per session.
    useEffect(() => {
      const host = hostRef.current
      if (!host) return
      const extensions = buildExtensions(prefs, {
        onChange: onChangeRef,
        onHistory: onHistoryRef,
        onScroll: onScrollRef,
        onPasteImages: onPasteImagesRef,
        onLongPressText: onLongPressTextRef,
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

      // Blank tail below the last line: clicking it drops the caret at the end
      // of the document. The area is scroller padding, so it has no line
      // number, no syntax highlight and no Markdown auto-conversion.
      const onTailPointerDown = (event: PointerEvent) => {
        if (event.target !== view.scrollDOM) return
        if (event.pointerType === 'mouse' && event.button !== 0) return
        const scrollerRect = view.scrollDOM.getBoundingClientRect()
        // Ignore the scrollbar strip on the right edge.
        if (event.clientX > scrollerRect.right - 12) return
        if (event.clientY <= view.contentDOM.getBoundingClientRect().bottom) return
        event.preventDefault()
        view.dispatch({ selection: { anchor: view.state.doc.length } })
        view.focus()
      }
      view.scrollDOM.addEventListener('pointerdown', onTailPointerDown)

      // Long press: a still press on the text opens the editor menu, the same
      // way a desktop right click does. Moving the finger cancels it, so
      // selecting text by dragging still works.
      let pressTimer = 0
      const pressFrom = { x: 0, y: 0 }
      const cancelPress = () => {
        if (pressTimer) {
          window.clearTimeout(pressTimer)
          pressTimer = 0
        }
      }
      const onPressDown = (event: PointerEvent) => {
        cancelPress()
        // A mouse reaches the menu through the contextmenu handler instead.
        if (event.pointerType === 'mouse') return
        pressFrom.x = event.clientX
        pressFrom.y = event.clientY
        pressTimer = window.setTimeout(() => {
          pressTimer = 0
          hapticTap(8)
          onLongPressTextRef.current({ x: pressFrom.x, y: pressFrom.y })
        }, LONG_PRESS_MS)
      }
      const onPressMove = (event: PointerEvent) => {
        if (Math.abs(event.clientX - pressFrom.x) > 10 || Math.abs(event.clientY - pressFrom.y) > 10) {
          cancelPress()
        }
      }
      const content = view.contentDOM
      content.addEventListener('pointerdown', onPressDown)
      content.addEventListener('pointermove', onPressMove)
      content.addEventListener('pointerup', cancelPress)
      content.addEventListener('pointercancel', cancelPress)

      return () => {
        cancelPress()
        content.removeEventListener('pointerdown', onPressDown)
        content.removeEventListener('pointermove', onPressMove)
        content.removeEventListener('pointerup', cancelPress)
        content.removeEventListener('pointercancel', cancelPress)
        view.scrollDOM.removeEventListener('pointerdown', onTailPointerDown)
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
        onLongPressText: onLongPressTextRef,
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
        cycleHeading: () => {
          const view = viewRef.current
          if (view) cycleHeading(view)
        },
        getTopLine: () => {
          const view = viewRef.current
          return view ? topLineOf(view) : 1
        },
        hasSelection: () => {
          const view = viewRef.current
          return view ? !view.state.selection.main.empty : false
        },
        selectionText: () => {
          const view = viewRef.current
          if (!view) return ''
          const { from, to } = view.state.selection.main
          return view.state.sliceDoc(from, to)
        },
        selectAll: () => {
          const view = viewRef.current
          if (!view) return
          view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
          view.focus()
        },
        deleteSelection: () => {
          const view = viewRef.current
          if (!view) return
          const { from, to } = view.state.selection.main
          if (from === to) return
          view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } })
          view.focus()
        },
        selectionAnchor: (press) => {
          const view = viewRef.current
          if (!view) return anchorFromCoords(null, null, press ?? null)
          const { from, to } = view.state.selection.main
          // `coordsAtPos` measures rendered text only, so either end can come
          // back null when it is scrolled out of view; the helper handles that.
          return anchorFromCoords(view.coordsAtPos(from), view.coordsAtPos(to), press ?? null)
        },
      }),
      [],
    )

    return <div className="markdown-editor" ref={hostRef} />
  },
)
