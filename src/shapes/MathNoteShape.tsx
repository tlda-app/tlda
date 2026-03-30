import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
  stopEventPropagation,
  DefaultColorStyle,
  createShapeId,
} from 'tldraw'
// Type imports not needed with 'any' approach
import { useCallback, useRef, useEffect, useState, useMemo, useSyncExternalStore } from 'react'
import { dropPillOnTarget } from './FleetPillShape'
import {
  switchTab,
  addTab,
  detachTab,
  checkMergeOverlap,
} from '../noteThreading'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { getActiveMacros } from '../katexMacros'
import { subscribeSearchFilter, getSearchFilter } from '../stores'
import { isDraft, subscribeDrafts, publishDraft } from '../annotationVisibility'
import { getVimMode, subscribeVimMode } from '../vimMode'

// CodeMirror imports
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { vim, getCM, Vim, CodeMirror as CM5 } from '@replit/codemirror-vim'
import { latex } from 'codemirror-lang-latex'

// Render markdown + KaTeX math
// Splits on math delimiters, renders non-math as markdown, math as KaTeX
function renderMarkdownMath(text: string, showErrors = false): string {
  const katexOptions = { macros: getActiveMacros(), throwOnError: true }

  // Split text into math and non-math segments
  // Preserve $$...$$ and $...$ as-is, render everything else as markdown
  const segments: Array<{ type: 'text' | 'display' | 'inline'; content: string }> = []
  let remaining = text

  while (remaining.length > 0) {
    // Look for display math first ($$...$$)
    const displayMatch = remaining.match(/\$\$([\s\S]+?)\$\$/)
    // Look for inline math ($...$)
    const inlineMatch = remaining.match(/\$([^$\n]+)\$/)

    const displayIdx = displayMatch?.index ?? Infinity
    const inlineIdx = inlineMatch?.index ?? Infinity

    if (displayIdx === Infinity && inlineIdx === Infinity) {
      // No more math
      segments.push({ type: 'text', content: remaining })
      break
    }

    const nextMathIdx = Math.min(displayIdx, inlineIdx)
    const isDisplay = displayIdx <= inlineIdx

    // Text before math
    if (nextMathIdx > 0) {
      segments.push({ type: 'text', content: remaining.slice(0, nextMathIdx) })
    }

    if (isDisplay && displayMatch) {
      segments.push({ type: 'display', content: displayMatch[1] })
      remaining = remaining.slice(nextMathIdx + displayMatch[0].length)
    } else if (inlineMatch) {
      segments.push({ type: 'inline', content: inlineMatch[1] })
      remaining = remaining.slice(nextMathIdx + inlineMatch[0].length)
    }
  }

  // Render each segment
  return segments.map(seg => {
    if (seg.type === 'display') {
      try {
        return katex.renderToString(seg.content.trim(), { ...katexOptions, displayMode: true })
      } catch (e: any) {
        if (!showErrors) return ''
        const msg = String(e.message || e || 'parse error').replace(/</g, '&lt;')
        return `<div style="color:#b91c1c;font-size:11px;margin:4px 0">${msg}</div>`
      }
    }
    if (seg.type === 'inline') {
      try {
        return katex.renderToString(seg.content.trim(), { ...katexOptions, displayMode: false })
      } catch (e: any) {
        if (!showErrors) return ''
        const msg = String(e.message || e || 'parse error').replace(/</g, '&lt;')
        return `<span style="color:#b91c1c;font-size:11px">${msg}</span>`
      }
    }
    // Markdown rendering for text segments
    return renderMarkdownText(seg.content)
  }).join('')
}

// Simple markdown rendering — no external deps
function renderMarkdownText(text: string): string {
  // Process line-by-line for block elements
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeLines: string[] = []
  let inList = false

  for (const line of lines) {
    // Code blocks
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        result.push(`<pre style="background:rgba(0,0,0,0.05);padding:6px 8px;border-radius:3px;font-size:12px;overflow-x:auto;margin:4px 0"><code>${codeLines.join('\n')}</code></pre>`)
        codeLines = []
        inCodeBlock = false
      } else {
        if (inList) { result.push('</ul>'); inList = false }
        inCodeBlock = true
      }
      continue
    }
    if (inCodeBlock) {
      codeLines.push(escapeHtml(line))
      continue
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      if (inList) { result.push('</ul>'); inList = false }
      const level = headingMatch[1].length
      const sizes = ['1.3em', '1.1em', '1em']
      const weights = ['700', '600', '600']
      result.push(`<div style="font-size:${sizes[level - 1]};font-weight:${weights[level - 1]};margin:${level === 1 ? '0 0 4px' : '6px 0 2px'}">${renderInline(headingMatch[2])}</div>`)
      continue
    }

    // Bullet lists
    if (line.match(/^\s*[-*]\s+/)) {
      if (!inList) { result.push('<ul style="margin:2px 0;padding-left:20px">'); inList = true }
      const content = line.replace(/^\s*[-*]\s+/, '')
      result.push(`<li style="margin:1px 0">${renderInline(content)}</li>`)
      continue
    }

    // End list if we're in one and this isn't a list item
    if (inList && line.trim() !== '') {
      result.push('</ul>')
      inList = false
    }

    // Empty lines
    if (line.trim() === '') {
      result.push('<br>')
      continue
    }

    // Regular text
    result.push(renderInline(line) + '<br>')
  }

  if (inCodeBlock) {
    result.push(`<pre style="background:rgba(0,0,0,0.05);padding:6px 8px;border-radius:3px;font-size:12px;overflow-x:auto;margin:4px 0"><code>${codeLines.join('\n')}</code></pre>`)
  }
  if (inList) result.push('</ul>')

  return result.join('')
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Inline markdown: bold, italic, code
function renderInline(text: string): string {
  let result = escapeHtml(text)
  // Inline code (before bold/italic to avoid conflicts)
  result = result.replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:2px;font-size:0.9em">$1</code>')
  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // Italic
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>')
  return result
}

// Legacy alias for KaTeX-only rendering (used in edit preview)
function renderMath(text: string, showErrors = false): string {
  return renderMarkdownMath(text, showErrors)
}

function hasMath(text: string): boolean {
  return /\$[^$]+\$/.test(text)
}

function hasMarkdown(text: string): boolean {
  return /^#{1,3}\s|^\s*[-*]\s|\*\*|`[^`]+`|```/.test(text) || text.includes('\n')
}

// Chapter-capable: starts with # (h1)
function isChapterCapable(text: string): boolean {
  return /^#\s+/.test(text.trim())
}

export const NOTE_COLORS: Record<string, string> = {
  'yellow': '#fef9c3',
  'red': '#fecaca',
  'green': '#bbf7d0',
  'blue': '#bfdbfe',
  'violet': '#ddd6fe',
  'orange': '#fed7aa',
  'grey': '#e5e5e5',
  'light-red': '#fecaca',
  'light-green': '#bbf7d0',
  'light-blue': '#bfdbfe',
  'light-violet': '#ddd6fe',
  'black': '#e5e5e5',
  'white': '#ffffff',
}

// Saturated dot colors for collapsed suggest notes
const DOT_COLORS: Record<string, string> = {
  'yellow': '#eab308',
  'red': '#ef4444',
  'green': '#22c55e',
  'blue': '#3b82f6',
  'violet': '#8b5cf6',
  'orange': '#f97316',
  'grey': '#9ca3af',
  'light-red': '#ef4444',
  'light-green': '#22c55e',
  'light-blue': '#3b82f6',
  'light-violet': '#8b5cf6',
  'black': '#6b7280',
  'white': '#d4d4d4',
}

// Entry mode: set before entering edit mode to dispatch vim command on mount
// 'i' = insert mode, ':' = ex command, null = normal mode (default)
let pendingEntryMode: 'i' | ':' | null = null
export function setMathNoteEntryMode(mode: 'i' | ':' | null) { pendingEntryMode = mode }

// Reply context: set before entering edit mode to show the tab being replied to
let pendingReplyContext: string | null = null
export function setReplyContext(text: string | null) { pendingReplyContext = text }

// CodeMirror theme: minimal, transparent, monospace
const cmTheme = EditorView.theme({
  '&': {
    backgroundColor: 'transparent',
    height: '100%',
  },
  '.cm-content': {
    fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
    fontSize: '13px',
    padding: '8px',
    color: '#1a1a1a',
    caretColor: '#1a1a1a',
  },
  '.cm-gutters': { display: 'none' },
  '&.cm-focused': { outline: 'none' },
  '.cm-activeLine': { backgroundColor: 'rgba(0,0,0,0.04)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(0,0,0,0.15) !important' },
  '.cm-panels': { fontSize: '12px' },
  '.cm-panels input': { fontFamily: 'monospace', fontSize: '12px' },
  '.cm-tooltip-autocomplete': {
    opacity: '0.5',
    fontSize: '11px',
    border: '1px solid rgba(0,0,0,0.1)',
    boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
  },
})

/**
 * In pen mode, finger touches should pass through to TLDraw (for palm rejection).
 * Only stop propagation for pen/mouse events or when not in pen mode.
 */
function stopIfNotPenTouch(editor: any) {
  return (e: React.PointerEvent) => {
    if (editor.getInstanceState().isPenMode && e.pointerType === 'touch') return
    stopEventPropagation(e)
  }
}

export class MathNoteShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'math-note' as const
  static override props = {
    w: T.number,
    h: T.number,
    text: T.string,
    color: DefaultColorStyle,
    autoSize: T.optional(T.boolean),
    choices: T.optional(T.arrayOf(T.string)),
    selectedChoice: T.optional(T.number),
    tabs: T.optional(T.arrayOf(T.string)),
    activeTab: T.optional(T.number),
    done: T.optional(T.boolean),
    collapsed: T.optional(T.boolean),
  }

  getDefaultProps() {
    return {
      w: 200,
      h: 50,
      text: '',
      color: 'light-blue',
      autoSize: true,
    }
  }

  override canEdit = (shape: any) => !shape.props.collapsed
  override canResize = () => true
  override canBind = () => false
  override isAspectRatioLocked = () => false
  override hideResizeHandles = () => false
  override hideRotateHandle = () => true
  override hideSelectionBoundsBg = () => false
  override hideSelectionBoundsFg = () => false

  override onTranslateEnd = (_initial: any, current: any) => {
    checkMergeOverlap(this.editor, current.id)
  }

  override onResize = (shape: any, info: any) => {
    const next = super.onResize!(shape, info) as any
    // Manual resize disables auto-size
    if (next.props) next.props.autoSize = false
    else next.props = { autoSize: false }
    return next
  }

  component(shape: any) {
    const editor = useEditor()
    const isEditing = editor.getEditingShapeId() === shape.id
    const cmContainerRef = useRef<HTMLDivElement>(null)
    const cmViewRef = useRef<EditorView | null>(null)
    const [localText, setLocalText] = useState(shape.props.text || '')
    const [previewHtml, setPreviewHtml] = useState('')
    const [isVimInsert, setIsVimInsert] = useState(false)
    const [vimMode, setVimMode] = useState('normal')
    const [splitPx, setSplitPx] = useState<number | null>(null)
    const isDraggingRef = useRef(false)
    const dragStartRef = useRef({ y: 0, splitPx: 0 })
    const previewRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const [cursorFraction, setCursorFraction] = useState(0)
    const [replyContext, setReplyContextState] = useState<string | null>(null)

    // Refs for sync coordination
    const tabBarRef = useRef<HTMLDivElement>(null)
    const suppressUpdateRef = useRef(false)
    const lastSentTextRef = useRef(shape.props.text || '')
    const modeJustChangedRef = useRef(false)
    // Track measured content height per tab so shape height = max across tabs
    const tabHeightsRef = useRef<number[]>([])

    const [dotHovered, setDotHovered] = useState(false)
    const [dotClicked, setDotClicked] = useState(false)

    const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
    const bgColor = NOTE_COLORS[shape.props.color] || NOTE_COLORS.yellow
    const isDone = shape.props.done === true
    const searchFilter = useSyncExternalStore(subscribeSearchFilter, getSearchFilter)
    const isFilteredOut = searchFilter !== null && !searchFilter.has(shape.id)
    const isDraftNote = useSyncExternalStore(subscribeDrafts, () => isDraft(shape.id))
    const useVim = useSyncExternalStore(subscribeVimMode, getVimMode)

    // Memoize KaTeX + markdown rendering — only re-parse when text actually changes
    const renderedHtml = useMemo(
      () => {
        const t = shape.props.text || ''
        if (hasMath(t) || hasMarkdown(t)) return renderMarkdownMath(t)
        return null
      },
      [shape.props.text],
    )
    const chapterCapable = useMemo(() => isChapterCapable(shape.props.text || ''), [shape.props.text])

    // Sync local text when shape changes from external source (undo, Yjs, etc)
    useEffect(() => {
      if (!isEditing) {
        setLocalText(shape.props.text || '')
      } else if (!isVimInsert && cmViewRef.current) {
        // In vim normal mode: accept incoming changes (e.g. Claude's reply)
        const incomingText = shape.props.text || ''
        if (incomingText !== lastSentTextRef.current) {
          suppressUpdateRef.current = true
          const view = cmViewRef.current
          const currentDoc = view.state.doc.toString()
          if (incomingText !== currentDoc) {
            view.dispatch({
              changes: { from: 0, to: currentDoc.length, insert: incomingText },
            })
            setLocalText(incomingText)
          }
          suppressUpdateRef.current = false
          lastSentTextRef.current = incomingText
        }
      }
    }, [shape.props.text, isEditing, isVimInsert])

    // Scroll preview to track cursor
    useEffect(() => {
      const el = previewRef.current
      if (!el || !isEditing) return
      const scrollRange = el.scrollHeight - el.clientHeight
      if (scrollRange > 0) {
        el.scrollTop = cursorFraction * scrollRange
      }
    }, [cursorFraction, isEditing, previewHtml])

    // Debounced KaTeX preview
    useEffect(() => {
      if (!isEditing) return
      const timer = setTimeout(() => {
        if (hasMath(localText)) {
          setPreviewHtml(renderMath(localText, true))
        } else {
          setPreviewHtml('')
        }
      }, 150)
      return () => clearTimeout(timer)
    }, [localText, isEditing])

    // Adjust note height on edit start/end
    useEffect(() => {
      if (isEditing) {
        // Expand for editing — at least 200px, but don't shrink if already larger
        const minEditH = 200
        if (shape.props.h < minEditH) {
          editor.updateShape({
            id: shape.id,
            type: 'math-note' as any,
            props: { h: minEditH },
          })
        }
        setSplitPx(null) // reset split on edit start
        if (pendingReplyContext) {
          setReplyContextState(pendingReplyContext)
          pendingReplyContext = null
        }
      } else {
        setReplyContextState(null)
        // Shrink to fit content when exiting edit mode
        if (shape.props.autoSize) {
          requestAnimationFrame(() => {
            const el = contentRef.current
            if (!el) return
            const contentH = el.scrollHeight
            const tabBarH = tabBarRef.current?.offsetHeight || 0
            const target = Math.max(40, contentH + tabBarH)
            const diff = target - shape.props.h
            if (Math.abs(diff) > 2) {
              if (diff < 0) {
                const rect = el.getBoundingClientRect()
                if (rect.height < 1) return // culled — skip shrink
              }
              editor.updateShape({
                id: shape.id,
                type: 'math-note' as any,
                props: { h: target },
              })
            }
          })
        }
      }
    }, [isEditing])

    // Reset per-tab height cache when tab count changes (tab added/removed)
    const numTabs = (shape.props.tabs as string[] | undefined)?.length || 1
    useEffect(() => { tabHeightsRef.current = [] }, [numTabs])

    // Auto-size: use ResizeObserver to track content height changes reliably.
    // This fires after KaTeX renders, font loading, and any async layout changes.
    // Height = max across all tabs so switching tabs doesn't cause resize jitter.
    // Only allow shrinking when the element is actually visible (not culled by TLDraw).
    useEffect(() => {
      if (isEditing || !shape.props.autoSize) return
      const el = contentRef.current
      if (!el) return
      const activeIdx = (shape.props.activeTab as number) || 0
      const measure = () => {
        const contentH = el.scrollHeight
        const tabBarH = tabBarRef.current?.offsetHeight || 0
        const thisTabH = contentH + tabBarH

        // Record this tab's measured height
        const heights = tabHeightsRef.current
        while (heights.length <= activeIdx) heights.push(0)
        heights[activeIdx] = thisTabH

        // Target = max across all measured tabs
        const target = Math.max(40, ...heights)
        const diff = target - shape.props.h
        if (Math.abs(diff) > 2) {
          // Only allow shrinking if the element is actually rendered.
          // TLDraw culls off-screen shapes — their content has 0/tiny scrollHeight.
          if (diff < 0) {
            const rect = el.getBoundingClientRect()
            if (rect.height < 1) return // culled — skip shrink
          }
          editor.updateShape({
            id: shape.id,
            type: 'math-note' as any,
            props: { h: target },
          })
        }
      }
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      measure()
      return () => ro.disconnect()
    }, [isEditing, shape.props.autoSize, shape.props.text, shape.props.w, shape.props.activeTab])

    // Create/destroy CodeMirror when editing state changes
    useEffect(() => {
      if (!isEditing || !cmContainerRef.current) {
        if (cmViewRef.current) {
          cmViewRef.current.destroy()
          cmViewRef.current = null
        }
        setIsVimInsert(false)
        setVimMode('normal')
        return
      }

      const exitEditing = () => {
        editor.setEditingShape(null)
      }

      const startState = EditorState.create({
        doc: shape.props.text || '',
        extensions: [
          ...(useVim ? [vim()] : []),
          latex(),
          // Auto-expand $$: typing second $ after first opens display math block
          EditorView.inputHandler.of((view, from, to, text) => {
            if (text === '$') {
              const before = view.state.doc.sliceString(from - 1, from)
              if (before === '$') {
                // Just typed the second $ — expand to $$\n|\n$$
                view.dispatch({
                  changes: { from: from - 1, to, insert: '$$\n\n$$' },
                  selection: { anchor: from + 2 },
                })
                return true
              }
            }
            return false
          }),
          EditorView.lineWrapping,
          cmTheme,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !suppressUpdateRef.current) {
              const text = update.state.doc.toString()
              setLocalText(text)
              lastSentTextRef.current = text
              editor.updateShape({
                id: shape.id,
                type: 'math-note' as any,
                props: { text },
              })
            }
            // Track cursor position for preview scroll
            if (update.selectionSet || update.docChanged) {
              const pos = update.state.selection.main.head
              const doc = update.state.doc
              const line = doc.lineAt(pos).number
              const totalLines = doc.lines
              setCursorFraction(totalLines <= 1 ? 0 : (line - 1) / (totalLines - 1))
            }
          }),
          // Low-priority Escape: only fires if vim didn't consume it
          // (i.e. we're in normal mode with no pending command)
          Prec.low(keymap.of([{
            key: 'Escape',
            run: () => {
              exitEditing()
              return true
            },
          }])),
        ],
      })

      const view = new EditorView({
        state: startState,
        parent: cmContainerRef.current,
      })

      cmViewRef.current = view
      lastSentTextRef.current = shape.props.text || ''

      // Track vim mode changes for Yjs sync and Escape handling
      const cm = useVim ? getCM(view) : null
      if (cm) {
        CM5.on(cm, 'vim-mode-change', (e: any) => {
          const inInsert = e.mode === 'insert'
          setIsVimInsert(inInsert)
          setVimMode(e.mode || 'normal')
          modeJustChangedRef.current = true
        })

        // :w to exit editing (save and close)
        Vim.defineEx('write', 'w', () => {
          exitEditing()
        })

        // :q to mark note as done and exit
        Vim.defineEx('quit', 'q', () => {
          editor.updateShape({
            id: shape.id,
            type: shape.type,
            props: { done: true },
          })
          exitEditing()
        })
      }

      // Capture Tab before TLDraw's global handler steals it
      const container = cmContainerRef.current
      const captureTab = (e: KeyboardEvent) => {
        if (e.key === 'Tab') {
          e.stopPropagation()
        }
      }
      container.addEventListener('keydown', captureTab, true)

      // Focus the editor
      view.focus()

      // Dispatch pending entry mode (from 'i' or ':' key when note was selected)
      if (useVim && pendingEntryMode && cm) {
        const mode = pendingEntryMode
        pendingEntryMode = null
        if (mode === 'i') {
          Vim.handleKey(cm, 'i', 'user')
        } else if (mode === ':') {
          Vim.handleKey(cm, ':', 'user')
        }
      }

      return () => {
        container.removeEventListener('keydown', captureTab, true)
        view.destroy()
        cmViewRef.current = null
        setIsVimInsert(false)
        setVimMode('normal')
      }
    }, [isEditing, useVim])

    // Wrapper keydown: stop TLDraw from stealing keys, handle Escape fallback
    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
      stopEventPropagation(e)
      if (e.key === 'Tab') {
        e.preventDefault()
      }
      if (e.key === 'Escape') {
        if (useVim && modeJustChangedRef.current) {
          // Mode just changed (insert→normal) on this keypress — don't exit
          modeJustChangedRef.current = false
        } else if (!useVim) {
          // No vim — Escape always exits
          editor.setEditingShape(null)
        } else {
          // Vim normal mode — exit editing
          editor.setEditingShape(null)
        }
      }
    }, [editor, useVim])

    // Divider drag handlers
    const handleDividerPointerDown = useCallback((e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      isDraggingRef.current = true
      const currentSplit = splitPx ?? Math.round(shape.props.h * 0.6)
      dragStartRef.current = { y: e.clientY, splitPx: currentSplit }
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    }, [splitPx, shape.props.h])

    const handleDividerPointerMove = useCallback((e: React.PointerEvent) => {
      if (!isDraggingRef.current) return
      e.preventDefault()
      e.stopPropagation()
      const dy = e.clientY - dragStartRef.current.y
      const newSplit = Math.max(60, Math.min(shape.props.h - 40, dragStartRef.current.splitPx + dy))
      setSplitPx(newSplit)
    }, [shape.props.h])

    const handleDividerPointerUp = useCallback((e: React.PointerEvent) => {
      isDraggingRef.current = false
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    }, [])

    // Render content
    let content: React.ReactNode
    if (isEditing) {
      const showPreview = hasMath(localText) && previewHtml
      const replyContextHtml = replyContext
        ? (hasMath(replyContext) ? renderMath(replyContext) : replyContext.replace(/\n/g, '<br>'))
        : null
      const contextHeight = replyContext ? Math.min(120, shape.props.h * 0.3) : 0
      const availH = shape.props.h - 16 - contextHeight // 16 for status bar
      const editorHeight = showPreview
        ? (splitPx ?? Math.round(availH * 0.6))
        : availH
      const previewHeight = showPreview
        ? availH - editorHeight - 6 // 6 for divider
        : 0

      content = (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
          }}
          onKeyDown={handleKeyDown}
          onPointerDown={stopIfNotPenTouch(editor)}
        >
          {/* Reply context — read-only view of the tab being replied to */}
          {replyContextHtml && (
            <div
              style={{
                height: contextHeight,
                overflow: 'auto',
                padding: '6px 8px',
                fontSize: '12px',
                lineHeight: 1.35,
                color: 'rgba(0,0,0,0.55)',
                backgroundColor: 'rgba(0,0,0,0.03)',
                borderBottom: '1px solid rgba(0,0,0,0.08)',
                flexShrink: 0,
              }}
              dangerouslySetInnerHTML={{ __html: replyContextHtml }}
            />
          )}
          {/* CodeMirror editor */}
          <div
            ref={cmContainerRef}
            style={{
              height: editorHeight,
              overflow: 'auto',
              flexShrink: 0,
            }}
          />
          {/* Draggable divider */}
          {showPreview && (
            <div
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              style={{
                height: '6px',
                cursor: 'row-resize',
                backgroundColor: 'rgba(0,0,0,0.06)',
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div style={{
                width: '30px',
                height: '2px',
                backgroundColor: 'rgba(0,0,0,0.2)',
                borderRadius: '1px',
              }} />
            </div>
          )}
          {/* Live KaTeX preview */}
          {showPreview && (
            <div
              ref={previewRef}
              style={{
                height: previewHeight,
                overflow: 'auto',
                padding: '8px',
                fontSize: '14px',
                lineHeight: 1.4,
                opacity: 0.85,
                flexShrink: 0,
              }}
              dangerouslySetInnerHTML={{ __html: previewHtml }}
            />
          )}
          {/* Status bar: vim mode + color dots */}
          <div
            className="math-note-statusbar"
            style={{
              height: '16px',
              lineHeight: '16px',
              fontSize: '9px',
              fontFamily: '"SF Mono", Menlo, monospace',
              padding: '0 8px',
              color: 'rgba(0,0,0,0.25)',
              backgroundColor: 'rgba(0,0,0,0.02)',
              borderTop: '1px solid rgba(0,0,0,0.04)',
              flexShrink: 0,
              userSelect: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>{useVim ? `-- ${vimMode.toUpperCase()} --` : ''}</span>
            <span className="math-note-colors" style={{
              display: 'flex',
              gap: '2px',
              opacity: 0.3,
              transition: 'opacity 0.15s',
            }}>
              {['light-blue', 'light-green', 'yellow', 'violet', 'orange', 'light-red', 'grey'].map(c => (
                <span
                  key={c}
                  onPointerDown={(e) => {
                    if (editor.getInstanceState().isPenMode && e.pointerType === 'touch') return
                    e.stopPropagation()
                    editor.updateShape({
                      id: shape.id,
                      type: 'math-note' as any,
                      props: { color: c },
                    })
                  }}
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: NOTE_COLORS[c],
                    border: shape.props.color === c ? '1.5px solid rgba(0,0,0,0.5)' : '1px solid rgba(0,0,0,0.12)',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </span>
            <style>{`.math-note-statusbar:hover .math-note-colors { opacity: 1 !important; }`}</style>
          </div>
        </div>
      )
    } else {
      const text = shape.props.text || ''
      const autoH = shape.props.autoSize
      const choices = shape.props.choices as string[] | undefined
      const selectedChoice = (shape.props.selectedChoice as number) ?? -1
      const shapeTabs = shape.props.tabs as string[] | undefined
      const hasChoices = choices && choices.length > 0 && (!shapeTabs || shapeTabs.length <= 1 || ((shape.props.activeTab as number) || 0) === 0)

      let textContent
      if (renderedHtml) {
        textContent = (
          <div
            style={{
              padding: '12px',
              paddingBottom: hasChoices ? '4px' : '12px',
              fontSize: '14px',
              lineHeight: 1.4,
              color: '#1a1a1a',
            }}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )
      } else {
        textContent = (
          <div
            style={{
              padding: '12px',
              paddingBottom: hasChoices ? '4px' : '12px',
              fontSize: '14px',
              lineHeight: 1.4,
              whiteSpace: 'pre-wrap',
              color: '#1a1a1a',
            }}
          >
            {text || '\u00A0'}
          </div>
        )
      }

      content = (
        <div
          ref={contentRef}
          onPointerUp={(e) => {
            // Trackpad click in pen mode: enter editing if shape is already selected
            if (!editor.getInstanceState().isPenMode) return
            if (e.pointerType !== 'mouse') return
            if (!editor.getSelectedShapeIds().includes(shape.id)) return
            editor.setEditingShape(shape.id)
          }}
          style={{
            overflow: autoH ? 'hidden' : 'auto',
            height: autoH ? 'auto' : '100%',
            boxSizing: 'border-box',
          }}
        >
          {textContent}
          {hasChoices && (
            <div style={{
              padding: '4px 10px 10px',
              display: 'flex',
              flexWrap: 'wrap',
              gap: '6px',
            }}>
              {choices.map((choice, i) => {
                const isSelected = selectedChoice === i
                const choiceHtml = hasMath(choice) ? renderMath(choice) : null
                return (
                  <button
                    key={i}
                    onPointerDown={(e) => {
                      if (editor.getInstanceState().isPenMode && e.pointerType === 'touch') return
                      e.stopPropagation()
                      editor.updateShape({
                        id: shape.id,
                        type: 'math-note' as any,
                        props: { selectedChoice: isSelected ? -1 : i },
                      })
                    }}
                    style={{
                      padding: '4px 12px',
                      fontSize: '12px',
                      lineHeight: 1.3,
                      border: isSelected ? '2px solid rgba(0,0,0,0.5)' : '1px solid rgba(0,0,0,0.15)',
                      borderRadius: '14px',
                      backgroundColor: isSelected ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.5)',
                      cursor: 'pointer',
                      fontWeight: isSelected ? 600 : 400,
                      transition: 'all 0.15s',
                    }}
                    {...(choiceHtml
                      ? { dangerouslySetInnerHTML: { __html: choiceHtml } }
                      : { children: choice }
                    )}
                  />
                )
              })}
            </div>
          )}
        </div>
      )
    }

    // Tab bar — single-shape model: tabs stored in props.tabs
    const tabs = shape.props.tabs as string[] | undefined
    const activeTabIdx = (shape.props.activeTab as number) || 0
    const showTabBar = !isEditing
    const multiTab = tabs && tabs.length > 1

    // Auto-widen shape when tabs overflow (up to 400px)
    const tabCount = tabs?.length ?? 0
    useEffect(() => {
      if (tabCount < 2) return
      const TAB_WIDTH = 70 // ~padding + preview text
      const PADDING = 60 // done + add + margin
      const needed = tabCount * TAB_WIDTH + PADDING
      const currentW = shape.props.w as number
      if (needed > currentW && currentW < 400) {
        const newW = Math.min(400, needed)
        editor.updateShape({ id: shape.id, type: shape.type, props: { w: newW } })
      }
    }, [tabCount]) // eslint-disable-line react-hooks/exhaustive-deps

    // Context menu state for tab detach (fallback)
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabIndex: number } | null>(null)

    useEffect(() => {
      if (!contextMenu) return
      const dismiss = () => setContextMenu(null)
      document.addEventListener('pointerdown', dismiss, true)
      return () => document.removeEventListener('pointerdown', dismiss, true)
    }, [contextMenu])

    // Drag-off state for tab detach
    const dragTabRef = useRef<{ index: number; startX: number; startY: number; active: boolean } | null>(null)

    // Drag handle state — drag note header to fleet-chat to insert content as annotation pill
    const pillDragRef = useRef<{ pillId: string | null; startX: number; startY: number; started: boolean } | null>(null)

    const handlePillDragDown = useCallback((e: React.PointerEvent) => {
      stopEventPropagation(e)
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      pillDragRef.current = { pillId: null, startX: e.clientX, startY: e.clientY, started: false }
    }, [])

    const handlePillDragMove = useCallback((e: React.PointerEvent) => {
      const drag = pillDragRef.current
      if (!drag) return
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY
      if (!drag.started && Math.hypot(dx, dy) < 5) return

      if (!drag.started) {
        drag.started = true
        const text = (shape.props.text as string) || ''
        const displayName = text.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]*\$/g, '').trim().slice(0, 40) || 'note'
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        const pillId = createShapeId()
        editor.createShape({
          id: pillId,
          type: 'fleet-pill' as any,
          x: pagePos.x - 35,
          y: pagePos.y - 9,
          props: { pillType: 'annotation', value: shape.id, displayName, color: '#8b5cf6' },
        })
        drag.pillId = pillId as string
      }

      if (drag.pillId) {
        const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
        editor.updateShape({ id: drag.pillId as any, type: 'fleet-pill' as any, x: pagePos.x - 35, y: pagePos.y - 9 })
      }
    }, [editor, shape])

    const handlePillDragUp = useCallback((e: React.PointerEvent) => {
      const drag = pillDragRef.current
      pillDragRef.current = null
      try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
      if (!drag?.started || !drag.pillId) return
      const text = (shape.props.text as string) || ''
      const pagePos = editor.screenToPage({ x: e.clientX, y: e.clientY })
      dropPillOnTarget(editor, drag.pillId as any, shape.id, pagePos, text)
      try { editor.deleteShapes([drag.pillId as any]) } catch {}
    }, [editor, shape])

    let tabBar: React.ReactNode = null
    if (showTabBar) {
      const inactiveColor = isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)'
      const activeColor = isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)'
      const activeBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'
      const borderColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'
      const doneColor = isDone
        ? (isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)')
        : (isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)')

      // Get tab label for a given index, using live text for active tab
      const getTabLabel = (i: number): string => {
        const raw = i === activeTabIdx ? (shape.props.text || '') : (tabs?.[i] || '')
        const preview = raw.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]*\$/g, '').trim()
        return preview ? preview.slice(0, 12).trim() + (preview.length > 12 ? '..' : '') : '\u00B7'
      }

      // Drag-off handler: on pointerdown, track start; on pointermove, if >30px vertical, detach
      const handleTabPointerDown = (e: React.PointerEvent, i: number) => {
        stopEventPropagation(e)
        if (e.button === 2) return
        dragTabRef.current = { index: i, startX: e.clientX, startY: e.clientY, active: false }
        const el = e.currentTarget as HTMLElement
        el.setPointerCapture(e.pointerId)
      }

      const handleTabPointerMove = (e: React.PointerEvent) => {
        const drag = dragTabRef.current
        if (!drag) return
        if (!multiTab) return
        const dy = Math.abs(e.clientY - drag.startY)
        if (dy > 30 && !drag.active) {
          drag.active = true
          const pagePoint = editor.screenToPage({ x: e.clientX, y: e.clientY })
          const newId = detachTab(editor, shape.id, drag.index, pagePoint.x, pagePoint.y)
          dragTabRef.current = null
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)

          // Continue dragging the detached shape via document-level listeners.
          // The user's pointer is still held down; we track it manually and
          // update the new shape's position until pointerup.
          if (newId) {
            editor.select(newId)
            const startPage = { ...pagePoint }
            const shapeStart = { x: pagePoint.x, y: pagePoint.y }
            let rafId = 0
            let lastClientX = e.clientX
            let lastClientY = e.clientY

            const onMove = (ev: PointerEvent) => {
              lastClientX = ev.clientX
              lastClientY = ev.clientY
              if (!rafId) {
                rafId = requestAnimationFrame(() => {
                  rafId = 0
                  const p = editor.screenToPage({ x: lastClientX, y: lastClientY })
                  editor.updateShape({
                    id: newId,
                    type: 'math-note',
                    x: shapeStart.x + (p.x - startPage.x),
                    y: shapeStart.y + (p.y - startPage.y),
                  } as any)
                })
              }
            }
            const onUp = () => {
              document.removeEventListener('pointermove', onMove)
              document.removeEventListener('pointerup', onUp)
              if (rafId) cancelAnimationFrame(rafId)
              // Final position update
              const p = editor.screenToPage({ x: lastClientX, y: lastClientY })
              editor.updateShape({
                id: newId,
                type: 'math-note',
                x: shapeStart.x + (p.x - startPage.x),
                y: shapeStart.y + (p.y - startPage.y),
              } as any)
              // Check for merge overlap on drop
              setTimeout(() => checkMergeOverlap(editor, newId), 0)
            }
            document.addEventListener('pointermove', onMove)
            document.addEventListener('pointerup', onUp)
          }
        }
      }

      const handleTabPointerUp = (e: React.PointerEvent, i: number) => {
        const drag = dragTabRef.current
        dragTabRef.current = null
        if (drag && !drag.active) {
          // Normal click — switch tab
          switchTab(editor, shape.id, i)
        }
        try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch {}
      }

      tabBar = (
        <div
          ref={tabBarRef}
          className="math-note-tabbar"
          style={{
            display: 'flex',
            alignItems: 'stretch',
            borderBottom: multiTab ? `1px solid ${borderColor}` : undefined,
            flexShrink: 0,
            overflowX: 'auto',
            scrollbarWidth: 'none',
          }}
        >
          {/* Done toggle */}
          <div
            className={`note-done-toggle-inline${isDone ? ' note-done-toggle-inline--active' : ''}`}
            onPointerDown={(e) => {
              stopEventPropagation(e)
              const newDone = !isDone
              editor.updateShape({
                id: shape.id,
                type: shape.type,
                props: { done: newDone },
              })
              if (newDone) {
                const pages = editor.getCurrentPageShapes()
                  .filter(s => (s.type as string) === 'svg-page')
                let bestPage: any = null
                let bestDist = Infinity
                for (const p of pages) {
                  const pb = editor.getShapePageBounds(p.id)
                  if (!pb) continue
                  const cy = shape.y + (shape.props as any).h / 2
                  const dist = cy < pb.minY ? pb.minY - cy : cy > pb.maxY ? cy - pb.maxY : 0
                  if (dist < bestDist) { bestDist = dist; bestPage = p }
                }
                if (bestPage) {
                  const pb = editor.getShapePageBounds(bestPage.id)
                  if (pb) {
                    editor.updateShape({
                      id: shape.id,
                      type: shape.type,
                      x: pb.maxX + 20,
                    } as any)
                  }
                }
              }
            }}
            style={{
              padding: '3px 4px',
              fontSize: '10px',
              cursor: 'pointer',
              userSelect: 'none',
              pointerEvents: 'all',
              flexShrink: 0,
              color: doneColor,
            }}
          >
            {isDone ? '\u2713' : '\u25CB'}
          </div>
          {/* Drag handle — drag to fleet-chat to insert note content as annotation */}
          <div
            onPointerDown={handlePillDragDown}
            onPointerMove={handlePillDragMove}
            onPointerUp={handlePillDragUp}
            style={{
              padding: '3px 5px',
              fontSize: '10px',
              cursor: 'grab',
              userSelect: 'none',
              pointerEvents: 'all',
              flexShrink: 0,
              color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
              letterSpacing: '1px',
            }}
            title="Drag to chat to insert note content"
          >
            {'⠿'}
          </div>
          {/* Tab labels (only when multi-tab) */}
          {multiTab && tabs.map((_, i) => (
            <div
              key={i}
              onPointerDown={(e) => handleTabPointerDown(e, i)}
              onPointerMove={handleTabPointerMove}
              onPointerUp={(e) => handleTabPointerUp(e, i)}
              onContextMenu={(e) => {
                e.preventDefault()
                stopEventPropagation(e)
                setContextMenu({ x: e.clientX, y: e.clientY, tabIndex: i })
              }}
              style={{
                padding: '3px 8px',
                fontSize: '10px',
                fontFamily: '-apple-system, sans-serif',
                cursor: 'pointer',
                userSelect: 'none',
                pointerEvents: 'all',
                flexShrink: 0,
                color: i === activeTabIdx ? activeColor : inactiveColor,
                fontWeight: i === activeTabIdx ? 600 : 400,
                borderBottom: i === activeTabIdx ? `2px solid ${activeColor}` : '2px solid transparent',
                backgroundColor: i === activeTabIdx ? activeBg : 'transparent',
                marginBottom: '-1px',
                maxWidth: '80px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {getTabLabel(i)}
            </div>
          ))}
          {/* + button inline with tabs */}
          <div
            className="note-tab-add"
            onPointerDown={(e) => {
              stopEventPropagation(e)
              addTab(editor, shape.id, '')
              requestAnimationFrame(() => {
                editor.setEditingShape(shape.id)
              })
            }}
            style={{
              padding: '3px 6px',
              fontSize: '12px',
              fontWeight: 300,
              fontFamily: '-apple-system, sans-serif',
              color: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)',
              cursor: 'pointer',
              userSelect: 'none',
              pointerEvents: 'all',
              flexShrink: 0,
            }}
          >
            +
          </div>
          {/* Spacer */}
          <div style={{ flex: 1 }} />
          {/* Publish button for draft notes */}
          {isDraftNote && (
            <div
              onPointerDown={(e) => {
                stopEventPropagation(e)
                publishDraft(editor, shape.id)
              }}
              style={{
                padding: '3px 8px',
                fontSize: '9px',
                fontFamily: '-apple-system, sans-serif',
                color: '#2563eb',
                cursor: 'pointer',
                userSelect: 'none',
                pointerEvents: 'all',
                flexShrink: 0,
                fontWeight: 500,
              }}
            >
              Publish
            </div>
          )}
          {/* Chapter indicator — drag note to right edge to add as book chapter */}
          {chapterCapable && (
            <div
              style={{
                padding: '2px 5px',
                fontSize: '9px',
                fontFamily: '-apple-system, sans-serif',
                color: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.18)',
                userSelect: 'none',
                pointerEvents: 'none',
                flexShrink: 0,
              }}
              title="Drag note to right edge to add as book chapter"
            >
              {'\u00A7'}
            </div>
          )}
        </div>
      )
    }

    // Context menu portal for detach (fallback for right-click)
    let contextMenuEl: React.ReactNode = null
    if (contextMenu) {
      contextMenuEl = (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 9999,
            background: isDark ? '#2a2a2a' : '#fff',
            border: `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}`,
            borderRadius: '4px',
            boxShadow: isDark ? '0 2px 8px rgba(0,0,0,0.4)' : '0 2px 8px rgba(0,0,0,0.12)',
            padding: '2px 0',
            pointerEvents: 'all',
          }}
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <div
            style={{
              padding: '4px 12px',
              fontSize: '12px',
              cursor: 'pointer',
              fontFamily: '-apple-system, sans-serif',
              color: isDark ? '#ccc' : undefined,
            }}
            onPointerDown={(e) => {
              stopEventPropagation(e)
              detachTab(editor, shape.id, contextMenu.tabIndex)
              setContextMenu(null)
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'
            }}
          >
            Detach tab
          </div>
        </div>
      )
    }

    // Collapsed suggest dot rendering
    const isCollapsed = shape.props.collapsed === true && !isEditing
    const showDotCard = isCollapsed && (dotHovered || dotClicked)
    const cameraZoom = useValue('zoom', () => editor.getCamera().z, [editor])
    if (isCollapsed) {
      const dotColor = DOT_COLORS[shape.props.color] || DOT_COLORS.orange
      const choices = shape.props.choices as string[] | undefined
      const selectedChoice = (shape.props.selectedChoice as number) ?? -1
      const hasChoices = choices && choices.length > 0
      const text = shape.props.text || ''
      const cardHtml = (hasMath(text) || hasMarkdown(text)) ? renderMarkdownMath(text) : null
      // Inverse scale so card renders at fixed screen size regardless of zoom
      const invZoom = 1 / cameraZoom

      return (
        <HTMLContainer
          id={shape.id}
          style={{
            overflow: 'visible',
            pointerEvents: 'all',
            position: 'relative',
          }}
        >
          <div
            onMouseEnter={() => setDotHovered(true)}
            onMouseLeave={() => setDotHovered(false)}
            style={{ position: 'relative' }}
          >
            {/* The dot */}
            <div
              onPointerDown={(e) => {
                stopEventPropagation(e)
                setDotClicked(!dotClicked)
              }}
              onDoubleClick={(e) => {
                // Prevent tldraw from entering edit mode
                stopEventPropagation(e)
                // Permanently expand on double-click
                editor.updateShape({
                  id: shape.id,
                  type: 'math-note' as any,
                  props: { collapsed: false, w: 220, h: 50, autoSize: true },
                })
              }}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: dotColor,
                cursor: 'pointer',
                boxShadow: `0 0 0 2px ${dotColor}33`,
                transition: 'transform 0.15s, box-shadow 0.15s',
                transform: showDotCard ? 'scale(1.3)' : 'scale(1)',
              }}
            />
            {/* Hover/click card — inverse-scaled to fixed screen size */}
            {showDotCard && (
              <div
                onPointerDown={stopIfNotPenTouch(editor)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 14,
                  transform: `scale(${invZoom})`,
                  transformOrigin: 'top left',
                  width: 260,
                  backgroundColor: bgColor,
                  borderRadius: 6,
                  boxShadow: '0 4px 16px rgba(0,0,0,0.18), 0 1px 4px rgba(0,0,0,0.1)',
                  zIndex: 1000,
                  pointerEvents: 'all',
                  overflow: 'hidden',
                }}
              >
                {/* Card content */}
                {cardHtml ? (
                  <div
                    style={{
                      padding: '10px 12px',
                      paddingBottom: hasChoices ? '4px' : '10px',
                      fontSize: '13px',
                      lineHeight: 1.4,
                      color: '#1a1a1a',
                      maxHeight: 200,
                      overflow: 'auto',
                    }}
                    dangerouslySetInnerHTML={{ __html: cardHtml }}
                  />
                ) : (
                  <div
                    style={{
                      padding: '10px 12px',
                      paddingBottom: hasChoices ? '4px' : '10px',
                      fontSize: '13px',
                      lineHeight: 1.4,
                      whiteSpace: 'pre-wrap',
                      color: '#1a1a1a',
                      maxHeight: 200,
                      overflow: 'auto',
                    }}
                  >
                    {text || '\u00A0'}
                  </div>
                )}
                {/* Choice buttons */}
                {hasChoices && (
                  <div style={{
                    padding: '4px 10px 10px',
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '6px',
                  }}>
                    {choices.map((choice, i) => {
                      const isSelected = selectedChoice === i
                      const choiceHtml = hasMath(choice) ? renderMath(choice) : null
                      return (
                        <button
                          key={i}
                          onPointerDown={(e) => {
                            if (editor.getInstanceState().isPenMode && e.pointerType === 'touch') return
                            e.stopPropagation()
                            editor.updateShape({
                              id: shape.id,
                              type: 'math-note' as any,
                              props: { selectedChoice: isSelected ? -1 : i },
                            })
                          }}
                          style={{
                            padding: '4px 10px',
                            fontSize: '11px',
                            lineHeight: 1.3,
                            border: isSelected ? '2px solid rgba(0,0,0,0.5)' : '1px solid rgba(0,0,0,0.15)',
                            borderRadius: '12px',
                            backgroundColor: isSelected ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.5)',
                            cursor: 'pointer',
                            fontWeight: isSelected ? 600 : 400,
                            transition: 'all 0.15s',
                          }}
                          {...(choiceHtml
                            ? { dangerouslySetInnerHTML: { __html: choiceHtml } }
                            : { children: choice }
                          )}
                        />
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </HTMLContainer>
      )
    }

    return (
      <HTMLContainer
        id={shape.id}
        style={{
          backgroundColor: bgColor,
          borderRadius: '4px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)',
          pointerEvents: 'all',
          display: 'flex',
          flexDirection: 'column',
          opacity: isFilteredOut ? 0.15 : undefined,
          transition: 'opacity 0.2s',
        }}
      >
          {tabBar}
          {shape.meta?.friendly_name && (
            <div style={{
              fontSize: 9,
              lineHeight: '14px',
              color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)',
              textAlign: 'right',
              padding: '0 6px',
              fontFamily: 'Inter, system-ui, sans-serif',
              letterSpacing: '0.02em',
              userSelect: 'none',
            }}>
              {shape.meta.friendly_name}
            </div>
          )}
          <div style={{
            flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative',
            ...(isDone && !isEditing ? { maxHeight: '28px', opacity: 0.35 } : {}),
          }}>
            {content}
          </div>
          {contextMenuEl}
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    if (shape.props.collapsed) {
      return <circle cx={5} cy={5} r={5} />
    }
    return <rect width={shape.props.w} height={shape.props.h} rx={4} ry={4} />
  }
}
