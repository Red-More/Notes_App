/**
 * Node-level Markdown marks that the Lezer tag layer cannot express: heading
 * symbols per level, ordered vs unordered list markers, task boxes, and quote
 * markers with their nesting depth. Colors live in the marker theme below so
 * they follow the syntax preferences; depth only lowers opacity.
 */

import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
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
      }

      if (className) marks.push({ from: ref.from, to: ref.to, className })
    },
  })
  return marks
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges = view.visibleRanges
  if (ranges.length === 0) return Decoration.none
  const from = ranges[0].from
  const to = ranges[ranges.length - 1].to
  const marks = syntaxMarksIn(view.state, from, to).sort(
    (left, right) => left.from - right.from || left.to - right.to,
  )
  const builder = new RangeSetBuilder<Decoration>()
  for (const mark of marks) {
    builder.add(mark.from, mark.to, Decoration.mark({ class: mark.className }))
  }
  return builder.finish()
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

/** H5/H6 share the H4 slot, matching the content highlight style. */
const HEADING_TOKENS: SyntaxToken[] = [
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading4',
  'heading4',
]

const MARKER_TOKENS: Array<{ className: string; token: SyntaxToken; fontWeight?: string }> = [
  { className: 'cm-md-list-mark', token: 'list' },
  { className: 'cm-md-ordered-mark', token: 'ordered' },
  { className: 'cm-md-task-mark', token: 'task', fontWeight: '600' },
  { className: 'cm-md-quote-mark', token: 'quote', fontWeight: '600' },
]

/**
 * Marker colors resolved from the same prefs as the tag highlighter. Disabled
 * tokens get no rule, so they fall back to the punctuation color (or plain text
 * for task boxes, which carry no highlight tag).
 */
export function buildMarkerTheme(prefs: SyntaxPrefs) {
  const rules: Record<string, Record<string, string>> = {}
  const colorFor = (token: SyntaxToken): string | null =>
    prefs.disabled.includes(token) ? null : syntaxColorCss(resolveSyntaxColor(prefs, token))

  HEADING_TOKENS.forEach((token, index) => {
    const color = colorFor(token)
    if (color) {
      // A softer tint of the heading color separates the marker from its text.
      rules[`.cm-md-heading-${index + 1}`] = { color, fontWeight: '600', opacity: '0.7' }
    }
  })
  for (const { className, token, fontWeight } of MARKER_TOKENS) {
    const color = colorFor(token)
    if (color) rules[`.${className}`] = fontWeight ? { color, fontWeight } : { color }
  }
  return EditorView.theme(rules)
}
