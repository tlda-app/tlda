import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  T,
  useEditor,
  useValue,
  stopEventPropagation,
  DefaultColorStyle,
  AssetRecordType,
} from 'tldraw'
// Type imports not needed with 'any' approach
import { useCallback, useRef, useEffect, useState, useMemo, useSyncExternalStore } from 'react'
// noteThreading removed — no tabs, no merge
import katex from 'katex'
import 'katex/dist/katex.min.css'
import MarkdownIt from 'markdown-it'
import { getActiveMacros } from '../katexMacros'

const md = new MarkdownIt({ html: true, breaks: true, linkify: true })
// Open all links in new tab so they don't navigate the tldraw iframe
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noopener')
  return self.renderToken(tokens, idx, options)
}
// Cache: local path → data URL (populated from tldraw asset store or fresh fetch)
const localImageCache = new Map<string, string>()
// Regex to find local image paths in markdown text
const LOCAL_IMG_RE = /!\[[^\]]*\]\(((?:~\/|\/)[^)]+)\)/g

// Rewrite local image paths: use cached data URL if available, else server URL
md.renderer.rules.image = (tokens, idx, options, _env, self) => {
  const token = tokens[idx]
  const src = token.attrGet('src') || ''
  if (src.startsWith('/') || src.startsWith('~')) {
    const cached = localImageCache.get(src)
    token.attrSet('src', cached || `/api/local-image?path=${encodeURIComponent(src)}`)
  }
  token.attrSet('style', 'max-width: 100%')
  token.attrSet('draggable', 'false')
  return self.renderToken(tokens, idx, options)
}
import { chatInsertBus } from './FleetPillShape'
import { subscribeSearchFilter, getSearchFilter } from '../stores'
import { getVimMode, subscribeVimMode } from '../vimMode'
import { appendToken } from '../authToken'

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
    return md.render(seg.content)
  }).join('')
}

// Legacy alias for KaTeX-only rendering (used in edit preview)
function renderMath(text: string, showErrors = false): string {
  return renderMarkdownMath(text, showErrors)
}

function hasMath(text: string): boolean {
  return /\$[^$]+\$/.test(text)
}

function hasMarkdown(text: string): boolean {
  return /^#{1,3}\s|^\s*[-*]\s|\*\*|`[^`]+`|```|!\[/.test(text) || text.includes('\n')
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
    done: T.optional(T.boolean),
    collapsed: T.optional(T.boolean),
    docName: T.optional(T.string),
    docView: T.optional(T.boolean),
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

  override canEdit = (shape: any) => !shape.props.collapsed && !shape.props.docView
  override canResize = (shape: any) => !shape.props.collapsed
  override canBind = () => false
  override isAspectRatioLocked = () => false
  override hideResizeHandles = (shape: any) => !!shape.props.collapsed
  override hideRotateHandle = () => true
  override hideSelectionBoundsBg = (shape: any) => !!shape.props.collapsed
  override hideSelectionBoundsFg = (shape: any) => !!shape.props.collapsed

  override getGeometry(shape: any) {
    if (shape.props.collapsed) {
      return new Rectangle2d({ width: 10, height: 10, isFilled: true })
    }
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  override onTranslateEnd = (initial: any, current: any) => {
    // If dropped on a fleet-chat shape → snap back + insert annotation token
    const bounds = this.editor.getShapePageBounds(current.id)
    if (bounds) {
      const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
      const chats = this.editor.getCurrentPageShapes().filter(s => (s.type as string) === 'fleet-chat') as any[]
      for (const chat of chats) {
        const cb = this.editor.getShapePageBounds(chat.id)
        if (!cb) continue
        if (center.x >= cb.x && center.x <= cb.x + cb.w && center.y >= cb.y && center.y <= cb.y + cb.h) {
          // Snap note back to original position
          this.editor.updateShape({ id: current.id, type: current.type, x: initial.x, y: initial.y })
          // Build token from active tab content
          const text = (current.props.text as string) || ''
          const displayName = text.replace(/\$\$[\s\S]*?\$\$/g, '').replace(/\$[^$]*\$/g, '').trim().slice(0, 40) || 'note'
          // Embed the shape ID so FleetChatShape can resolve it via editor.getShape()
          const token = `«annotation:${displayName}#${current.id}»`
          const wasLocked = (chat as any).isLocked
          if (wasLocked) this.editor.updateShape({ id: chat.id, type: 'fleet-chat' as any, isLocked: false })
          chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { chatId: chat.id, text: token } }))
          if (wasLocked) this.editor.updateShape({ id: chat.id, type: 'fleet-chat' as any, isLocked: true })
          return
        }
      }
    }
  }

  override onClick = (shape: any) => {
    if (shape.props.collapsed) {
      this.editor.updateShape({
        id: shape.id,
        type: shape.type,
        props: { collapsed: false },
      })
    }
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
    const suppressUpdateRef = useRef(false)
    const lastSentTextRef = useRef(shape.props.text || '')
    const modeJustChangedRef = useRef(false)
    const [dotHovered, setDotHovered] = useState(false)
    const [imgVersion, setImgVersion] = useState(0)

    const docName = shape.props.docName as string | undefined
    const showDoc = !!(shape.props.docName && shape.props.docView)
    // True while this note is pushing content to the doc — prevents echo-back on next poll
    const pushingToDocRef = useRef(false)

    const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
    const bgColor = NOTE_COLORS[shape.props.color] || NOTE_COLORS.yellow
    const searchFilter = useSyncExternalStore(subscribeSearchFilter, getSearchFilter)
    const isFilteredOut = searchFilter !== null && !searchFilter.has(shape.id)
    const useVim = useSyncExternalStore(subscribeVimMode, getVimMode)

    // Lazy image registration: fetch local images, store as tldraw assets + module cache
    useEffect(() => {
      const text = shape.props.text || ''
      LOCAL_IMG_RE.lastIndex = 0
      const paths = new Set<string>()
      let m: RegExpExecArray | null
      while ((m = LOCAL_IMG_RE.exec(text)) !== null) paths.add(m[1])
      if (paths.size === 0) return
      let registered = false
      Promise.all([...paths].map(async (path) => {
        if (localImageCache.has(path)) return
        const assetId = AssetRecordType.createId('local-' + encodeURIComponent(path))
        const existing = editor.getAsset(assetId)
        if (existing) { localImageCache.set(path, (existing.props as any).src); registered = true; return }
        try {
          const resp = await fetch(`/api/local-image?path=${encodeURIComponent(path)}`)
          if (!resp.ok) return
          const blob = await resp.blob()
          const dataUrl = await new Promise<string>((res, rej) => {
            const r = new FileReader(); r.onloadend = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(blob)
          })
          localImageCache.set(path, dataUrl)
          editor.createAssets([{ id: assetId, typeName: 'asset', type: 'image', meta: {},
            props: { w: 0, h: 0, mimeType: blob.type || 'image/png', src: dataUrl, name: path, isAnimated: false } }])
          registered = true
        } catch { /* server URL fallback stays */ }
      })).then(() => { if (registered) setImgVersion(v => v + 1) })
    }, [shape.props.text, editor])

    // note → doc sync: push text to linked doc (debounced 1s)
    useEffect(() => {
      if (!docName) return
      const text = shape.props.text || ''
      const timer = setTimeout(async () => {
        pushingToDocRef.current = true
        try {
          // Auto-create the doc if it doesn't exist
          const existsRes = await fetch(`/api/projects/${docName}`)
          if (!existsRes.ok) {
            await fetch('/api/projects', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: docName, title: docName, format: 'markdown', mainFile: 'main.md' }),
            })
          }
          await fetch(`/api/projects/${docName}/push`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: [{ path: 'main.md', content: text }] }),
          })
        } catch { /* ignore — server may not be running */ }
        // Hold the suppression flag long enough to skip the next poll cycle
        setTimeout(() => { pushingToDocRef.current = false }, 2500)
      }, 1000)
      return () => clearTimeout(timer)
    }, [shape.props.text, docName])

    // doc → note sync: poll source file every 3s and apply if changed
    useEffect(() => {
      if (!docName) return
      const shapeId = shape.id
      const poll = async () => {
        if (pushingToDocRef.current) return
        if (editor.getEditingShapeId() === shapeId) return
        try {
          const res = await fetch(`/api/projects/${docName}/source/main.md`)
          if (!res.ok) return
          const content = await res.text()
          const current = (editor.getShape(shapeId) as any)?.props?.text ?? ''
          if (content !== current) {
            editor.updateShape({ id: shapeId, type: 'math-note' as any, props: { text: content } })
          }
        } catch { /* ignore */ }
      }
      const interval = setInterval(poll, 3000)
      return () => clearInterval(interval)
    }, [docName, shape.id, editor])

    // Memoize KaTeX + markdown rendering — only re-parse when text or registered images change
    const renderedHtml = useMemo(
      () => {
        const t = shape.props.text || ''
        if (hasMath(t) || hasMarkdown(t)) return renderMarkdownMath(t)
        return null
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [shape.props.text, imgVersion],
    )

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
            const target = Math.max(40, contentH)
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

    // Auto-size: use ResizeObserver to track content height changes reliably.
    // Only allow shrinking when the element is actually visible (not culled by TLDraw).
    useEffect(() => {
      if (isEditing || !shape.props.autoSize) return
      const el = contentRef.current
      if (!el) return
      const measure = () => {
        const contentH = el.scrollHeight
        const target = Math.max(40, contentH)
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
      }
      const ro = new ResizeObserver(measure)
      ro.observe(el)
      measure()
      return () => ro.disconnect()
    }, [isEditing, shape.props.autoSize, shape.props.text, shape.props.w, shape.props.collapsed])

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
      const hasChoices = choices && choices.length > 0

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
          >
            <style>{`
              .math-note-prose table { border-collapse: collapse; width: 100%; }
              .math-note-prose table td, .math-note-prose table th { border: 1px solid rgba(0,0,0,0.15); padding: 4px 8px; }
              .math-note-prose p { margin: 0 0 0.6em; }
              .math-note-prose p:last-child { margin-bottom: 0; }
            `}</style>
            <div
              className="math-note-prose"
              style={{ maxWidth: '72ch', margin: '0 auto' }}
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          </div>
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


    // Collapsed dot rendering
    const isCollapsed = shape.props.collapsed === true && !isEditing
    const cameraZoom = useValue('zoom', () => editor.getCamera().z, [editor])
    if (isCollapsed) {
      const dotColor = DOT_COLORS[shape.props.color] || DOT_COLORS.orange
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
              onClick={(e) => {
                e.stopPropagation()
                editor.updateShape({
                  id: shape.id,
                  type: shape.type,
                  props: { collapsed: false },
                })
              }}
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: dotColor,
                cursor: 'pointer',
                boxShadow: `0 0 0 2px ${dotColor}33`,
                position: 'relative',
                zIndex: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {/* Sticky note icon */}
              <svg width="6" height="6" viewBox="0 0 16 16" fill="white" style={{ opacity: 0.35, pointerEvents: 'none' }}>
                <path d="M2 1h12v10l-4 4H2V1z" />
                <path d="M10 11v4l4-4h-4z" fill={dotColor} opacity="0.6" />
              </svg>
            </div>
            {/* Hover preview */}
            {dotHovered && (
              <div
                style={{
                  position: 'absolute',
                  top: -4,
                  left: -4,
                  transform: `scale(${invZoom})`,
                  transformOrigin: 'top left',
                  width: shape.props.w || 220,
                  minHeight: shape.props.h || 50,
                  backgroundColor: bgColor,
                  borderRadius: 4,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)',
                  zIndex: 1,
                  pointerEvents: 'none',
                  display: 'flex',
                  flexDirection: 'column',
                  opacity: 0.95,
                }}
              >
                <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative', pointerEvents: 'none' }}>
                  {content}
                </div>
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
          position: 'relative',
          opacity: isFilteredOut ? 0.15 : undefined,
          transition: 'opacity 0.2s',
        }}
      >
          {/* Collapse in-place — top-left dot */}
          <div
            onPointerDown={(e) => {
              stopEventPropagation(e)
              editor.updateShape({
                id: shape.id,
                type: shape.type,
                props: { collapsed: true },
              })
            }}
            style={{
              position: 'absolute',
              top: 4,
              left: 4,
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: DOT_COLORS[shape.props.color] || DOT_COLORS.orange,
              cursor: 'pointer',
              zIndex: 10,
              opacity: 0.5,
              transition: 'opacity 0.15s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
            title="Collapse in place"
          />
          {/* Toggle doc view — top-right tlda logo button (only when docName is set) */}
          {docName && (
            <div
              onPointerDown={(e) => {
                stopEventPropagation(e)
                editor.updateShape({
                  id: shape.id,
                  type: 'math-note' as any,
                  props: { docView: !shape.props.docView },
                })
              }}
              title={showDoc ? 'Show note' : `Open doc: ${docName}`}
              style={{
                position: 'absolute',
                top: 3,
                right: 4,
                width: 16,
                height: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                opacity: showDoc ? 0.8 : 0.3,
                transition: 'opacity 0.15s',
                zIndex: 10,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.8' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = showDoc ? '0.8' : '0.3' }}
            >
              {/* tlda logo — stylized "t" document shape */}
              <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
                <rect x="2" y="1" width="13" height="16" rx="2" opacity="0.9"/>
                <rect x="5" y="5" width="7" height="1.5" rx="0.75" fill="white" opacity="0.8"/>
                <rect x="5" y="8" width="7" height="1.5" rx="0.75" fill="white" opacity="0.8"/>
                <rect x="5" y="11" width="4" height="1.5" rx="0.75" fill="white" opacity="0.8"/>
              </svg>
            </div>
          )}
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
          }}>
            {showDoc && docName ? (
              <iframe
                src={appendToken(`/?doc=${docName}`)}
                style={{
                  width: '100%',
                  height: '100%',
                  border: 'none',
                  display: 'block',
                  pointerEvents: 'all',
                }}
                sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
              />
            ) : content}
          </div>
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
