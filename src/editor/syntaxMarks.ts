/**
 * Node-level Markdown marks that the Lezer tag layer cannot express: heading
 * symbols per level, ordered vs unordered list markers, task boxes, quote
 * markers with nesting depth, inline code boxes and code-block text.
 * Colors live in the marker theme below so they follow the syntax preferences;
 * depth only lowers opacity.
 */

import { syntaxTree } from '@codemirror/language'
import { type EditorState, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import {
  resolveSyntaxColor,
  syntaxColorCss,
  type SyntaxPrefs,
  type SyntaxToken,
} from './syntaxPrefs'

/** Structural view of a Lezer node; keeps @lezer/common out of the imports. */
type SyntaxNodeLike = { name: string; parent: SyntaxNodeLike | null }

export interface SyntaxMark {
  from: number
  to: number
  className: string
}

/** One line-level class, used for code-block and quote backgrounds. */
export interface SyntaxLineMark {
  from: number
  className: string
}

const MAX_DEPTH = 5
const DEPTH_CLASSES = Array.from({ length: MAX_DEPTH }, (_, index) => `cm-md-depth-${index + 1}`)

function clampDepth(depth: number): number {
  return Math.min(MAX_DEPTH, Math.max(1, depth))
}

function countAncestors(node: SyntaxNodeLike, name: string): number {
  let count = 0
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === name) count += 1
  }
  return count
}

function insideCodeBlock(node: SyntaxNodeLike): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === 'FencedCode' || parent.name === 'CodeBlock') return true
  }
  return false
}

/** Closest list ancestor tells ordered from unordered; all list ancestors give depth. */
function listContext(node: SyntaxNodeLike): { ordered: boolean; depth: number } {
  let ordered = false
  let depth = 0
  let foundNearest = false
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name !== 'BulletList' && parent.name !== 'OrderedList') continue
    depth += 1
    if (!foundNearest) {
      foundNearest = true
      ordered = parent.name === 'OrderedList'
    }
  }
  return { ordered, depth: clampDepth(depth) }
}

/** First and last line numbers covered by a syntax node, excluding a trailing
 * line that the node only touches at its very start. */
function linesInRange(
  state: EditorState,
  from: number,
  to: number,
): { first: number; last: number } {
  const first = state.doc.lineAt(from).number
  let last = state.doc.lineAt(Math.min(to, state.doc.length)).number
  if (to === state.doc.line(last).from && last > first) last -= 1
  return { first, last }
}

/**
 * Collect marker classes in document order for the given range. Ranges are
 * clamped by the caller to the visible part of the document.
 */
export function syntaxMarksIn(state: EditorState, from: number, to: number): SyntaxMark[] {
  const marks: SyntaxMark[] = []
  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node as SyntaxNodeLike
      let className: string | null = null

      if (ref.name === 'HeaderMark') {
        const level = /^(?:ATX|Setext)Heading(\d)$/.exec(node.parent?.name ?? '')?.[1]
        if (level) className = `cm-md-mark cm-md-heading-mark cm-md-heading-${level}`
      } else if (ref.name === 'ListMark') {
        const { ordered, depth } = listContext(node)
        className = `cm-md-mark ${ordered ? 'cm-md-ordered-mark' : 'cm-md-list-mark'} ${DEPTH_CLASSES[depth - 1]}`
      } else if (ref.name === 'TaskMarker') {
        const { depth } = listContext(node)
        const done = state.sliceDoc(ref.from + 1, ref.from + 2).toLowerCase() === 'x'
        className = `cm-md-mark cm-md-task-mark ${DEPTH_CLASSES[depth - 1]}${
          done ? ' cm-md-task-done' : ''
        }`
      } else if (ref.name === 'QuoteMark') {
        const depth = clampDepth(countAncestors(node, 'Blockquote'))
        className = `cm-md-mark cm-md-quote-mark ${DEPTH_CLASSES[depth - 1]}`
      } else if (ref.name === 'InlineCode') {
        className = 'cm-md-mark cm-md-inline-code'
      } else if (ref.name === 'CodeText' && insideCodeBlock(node)) {
        className = 'cm-md-mark cm-md-codeblock-text'
      }

      if (className) marks.push({ from: ref.from, to: ref.to, className })
    },
  })
  return marks
}

/**
 * Collect line classes for code blocks (background) and blockquotes
 * (background + left bar). Nested quotes keep the deepest level per line.
 */
export function syntaxLineMarksIn(state: EditorState, from: number, to: number): SyntaxLineMark[] {
  const codeLines = new Set<number>()
  const quoteLines = new Map<number, number>()

  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node as SyntaxNodeLike
      if (ref.name === 'FencedCode' || ref.name === 'CodeBlock') {
        const { first, last } = linesInRange(state, ref.from, ref.to)
        for (let number = first; number <= last; number += 1) {
          codeLines.add(state.doc.line(number).from)
        }
      } else if (ref.name === 'Blockquote') {
        const depth = clampDepth(countAncestors(node, 'Blockquote') + 1)
        const { first, last } = linesInRange(state, ref.from, ref.to)
        for (let number = first; number <= last; number += 1) {
          const lineFrom = state.doc.line(number).from
          quoteLines.set(lineFrom, Math.max(quoteLines.get(lineFrom) ?? 0, depth))
        }
      }
    },
  })

  const lines: SyntaxLineMark[] = []
  for (const lineFrom of codeLines) {
    lines.push({ from: lineFrom, className: 'cm-md-code-line' })
  }
  for (const [lineFrom, depth] of quoteLines) {
    lines.push({ from: lineFrom, className: `cm-md-quote-line cm-md-depth-${depth}` })
  }
  return lines.sort((left, right) => left.from - right.from)
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges = view.visibleRanges
  if (ranges.length === 0) return Decoration.none
  const from = ranges[0].from
  const to = ranges[ranges.length - 1].to

  const decorations: Range<Decoration>[] = []
  for (const mark of syntaxMarksIn(view.state, from, to)) {
    decorations.push(Decoration.mark({ class: mark.className }).range(mark.from, mark.to))
  }
  for (const line of syntaxLineMarksIn(view.state, from, to)) {
    decorations.push(Decoration.line({ class: line.className }).range(line.from))
  }
  return Decoration.set(decorations, true)
}

/** Rebuild marks when the document, viewport or parsed tree changes. */
export const syntaxMarkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** H5/H6 now have their own palette slots. */
const HEADING_TOKENS: SyntaxToken[] = [
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
]

const MARKER_TOKENS: Array<{
  className: string
  token: SyntaxToken
  fontWeight?: string
  background?: string
}> = [
  { className: 'cm-md-list-mark', token: 'list' },
  { className: 'cm-md-ordered-mark', token: 'ordered' },
  { className: 'cm-md-task-mark', token: 'task', fontWeight: '600' },
  { className: 'cm-md-quote-mark', token: 'quote', fontWeight: '600' },
  {
    className: 'cm-md-inline-code',
    token: 'code',
    background: syntaxColorCss('inlineCodeBg'),
  },
  { className: 'cm-md-codeblock-text', token: 'codeBlock' },
]

/**
 * Marker colors resolved from the same prefs as the tag highlighter. Disabled
 * tokens get no rule, so they fall back to the punctuation color (or plain text
 * where no tag applies).
 */
export function buildMarkerTheme(prefs: SyntaxPrefs) {
  const rules: Record<string, Record<string, string>> = {}
  const colorFor = (token: SyntaxToken): string | null =>
    prefs.disabled.includes(token) ? null : syntaxColorCss(resolveSyntaxColor(prefs, token))

  HEADING_TOKENS.forEach((token, index) => {
    const color = colorFor(token)
    if (color) {
      rules[`.cm-md-heading-${index + 1}`] = { color, fontWeight: '600' }
    }
  })

  for (const { className, token, fontWeight, background } of MARKER_TOKENS) {
    const color = colorFor(token)
    if (!color) continue
    const style: Record<string, string> = { color }
    if (fontWeight) style.fontWeight = fontWeight
    if (background) style.backgroundColor = background
    rules[`.${className}`] = style
  }

  const taskDone = colorFor('taskDone')
  if (taskDone) {
    rules['.cm-md-task-mark.cm-md-task-done'] = { color: taskDone }
  }

  if (colorFor('codeBlock')) {
    rules['.cm-md-code-line'] = { backgroundColor: syntaxColorCss('codeBlockBg') }
  }
  const quoteColor = colorFor('quote')
  if (quoteColor) {
    rules['.cm-md-quote-line'] = {
      backgroundColor: syntaxColorCss('quoteBg'),
      boxShadow: `inset 3px 0 0 ${quoteColor}`,
    }
  }

  return EditorView.theme(rules)
}
