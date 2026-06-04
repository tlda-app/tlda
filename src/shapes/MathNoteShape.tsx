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
import { useCallback, useRef, useEffect, useState, useMemo, useSyncExternalStore, useContext } from 'react'
// noteThreading removed — no tabs, no merge
import katex from 'katex'
import 'katex/dist/katex.min.css'
import MarkdownIt from 'markdown-it'
import { getActiveMacros } from '../katexMacros'
import { DocContext } from '../PanelContext'
import { fetchProofInfo } from '../docInfoCache'
import { linkifyArrowRefs, linkifyAtRefs, refToCanvas, type LabelRegionInfo, type ResolvedRef } from '../docLinks'
import { PDF_HEIGHT } from '../layoutConstants'

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
import { setVoiceAccumulator, clearVoiceAccumulator, notifyAccumulatorCursorMoved } from '../voice.mjs'
import { subscribeSearchFilter, getSearchFilter, addBulletContext, subscribeBulletContext, getBulletContexts, genBulletId } from '../stores'
import { onFileUpdatedSignal } from '../useYjsSync'
import { chatInsertBus } from './FleetPillShape'
import { getVimMode, subscribeVimMode } from '../vimMode'
import { appendToken } from '../authToken'

// CodeMirror imports
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { vim, getCM, Vim, CodeMirror as CM5 } from '@replit/codemirror-vim'
import { latex } from 'codemirror-lang-latex'

// Render markdown + KaTeX math
// Extracts math, replaces with placeholder tokens, renders the whole text as
// markdown ONCE (so paragraph structure is correct), then swaps the rendered
// KaTeX HTML back in. Rendering text segments individually causes markdown-it
// to wrap each one in its own <p>, which produces spurious line breaks around
// every inline $...$.
export function renderMarkdownMath(text: string, showErrors = false): string {
  const katexOptions = { macros: getActiveMacros(), throwOnError: true }
  const placeholders: string[] = []

  const renderMath = (content: string, displayMode: boolean): string => {
    try {
      return katex.renderToString(content.trim(), { ...katexOptions, displayMode })
    } catch (e: any) {
      if (!showErrors) return ''
      const msg = String(e.message || e || 'parse error').replace(/</g, '&lt;')
      return displayMode
        ? `<div style="color:#b91c1c;font-size:11px;margin:4px 0">${msg}</div>`
        : `<span style="color:#b91c1c;font-size:11px">${msg}</span>`
    }
  }

  const makeToken = (html: string): string => {
    const idx = placeholders.length
    placeholders.push(html)
    // Alphanumeric token survives markdown-it untouched. Padded with letters
    // so markdown-it doesn't see digits-only and treat as a list/ordinal.
    return `MATHPLACEHOLDERZZZ${idx}ZZZ`
  }

  // Replace display math first ($$...$$), then inline ($...$).
  // Standalone display math (on its own line) gets blank-line padding so
  // markdown-it treats it as its own paragraph. Inline display math (inside
  // a bullet or sentence) stays inline to avoid breaking list structure.
  let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, content, offset) => {
    const token = makeToken(renderMath(content, true))
    const before = text.slice(Math.max(0, offset - 1), offset)
    const afterEnd = offset + _m.length
    const after = text.slice(afterEnd, afterEnd + 1)
    const standalone = (offset === 0 || before === '\n') && (afterEnd >= text.length || after === '\n')
    return standalone ? `\n\n${token}\n\n` : token
  })
  processed = processed.replace(/\$([^$\n]+)\$/g, (_m, content) => {
    return makeToken(renderMath(content, false))
  })

  // Render the whole thing as markdown in one pass so paragraph/inline
  // structure is correct.
  let html = md.render(processed)

  // Swap placeholders back. Display-math placeholders end up in their own
  // <p>...</p>; unwrap those so the KaTeX block isn't nested in a paragraph.
  html = html.replace(/<p>\s*(MATHPLACEHOLDERZZZ\d+ZZZ)\s*<\/p>/g, '$1')
  html = html.replace(/MATHPLACEHOLDERZZZ(\d+)ZZZ/g, (_m, idx) => placeholders[Number(idx)] || '')

  return html
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
// Stop event propagation only when the note is being edited.
// When not editing, let TLDraw handle pointer events so the shape is draggable.
function stopIfNotPenTouch(editor: any, isEditing: boolean) {
  return (e: React.PointerEvent) => {
    if (!isEditing) return // let TLDraw handle drag
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
    backingFile: T.optional(T.string),
  }

  getDefaultProps() {
    // Match the MCP `md` size preset (450×200) so canvas-created notes have
    // room for paragraph + math content without immediate resizing.
    return {
      w: 450,
      h: 200,
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
    const dotHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const [imgVersion, setImgVersion] = useState(0)
    const [backingSyncState, setBackingSyncState] = useState<'synced' | 'pushing' | 'stale'>('synced')

    const docName = shape.props.docName as string | undefined
    const showDoc = !!(shape.props.docName && shape.props.docView)
    // True while this note is pushing content to the doc — prevents echo-back on next poll
    const pushingToDocRef = useRef(false)
    // Track text at edit start so backing-file write-back only fires on actual edits
    const textAtEditStartRef = useRef<string | null>(null)

    // Label regions from the current document (for [->label] links)
    const pageDoc = useContext(DocContext)
    const [labelRegions, setLabelRegions] = useState<Record<string, LabelRegionInfo>>({})
    useEffect(() => {
      if (!pageDoc?.docName) return
      fetchProofInfo(pageDoc.docName).then(data => {
        if (data?.labelRegions) setLabelRegions(data.labelRegions)
      })
    }, [pageDoc?.docName])

    const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
    const bgColor = NOTE_COLORS[shape.props.color] || NOTE_COLORS.yellow
    const searchFilter = useSyncExternalStore(subscribeSearchFilter, getSearchFilter)
    const isFilteredOut = searchFilter !== null && !searchFilter.has(shape.id)
    const useVim = useSyncExternalStore(subscribeVimMode, getVimMode)
    const activeBullets = useSyncExternalStore(subscribeBulletContext, getBulletContexts)

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

    // Backing file: register with the server so the daemon watches for changes
    const backingFile = shape.props.backingFile as string | undefined
    useEffect(() => {
      if (!backingFile) return
      const docParam = new URLSearchParams(window.location.search).get('doc')
      if (!docParam) return
      fetch('/api/backing-file-register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: backingFile, docName: docParam }),
      }).catch(e => console.warn('[math-note] backing file register failed:', e.message))
    }, [backingFile])

    // Backing file: write to file only when the user actually changed the text
    useEffect(() => {
      if (!backingFile) return
      if (isEditing) {
        textAtEditStartRef.current = (editor.getShape(shape.id) as any)?.props?.text ?? ''
        return
      }
      const content = (editor.getShape(shape.id) as any)?.props?.text ?? ''
      if (textAtEditStartRef.current === null || content === textAtEditStartRef.current) return
      textAtEditStartRef.current = null
      setBackingSyncState('pushing')
      fetch('/api/backing-file-write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: backingFile, content }),
      }).then(() => setBackingSyncState('synced'))
        .catch(() => setBackingSyncState('stale'))
    }, [isEditing])

    // Backing file conflict: when the file changes externally while the note
    // has different content, split into two notes (file version + canvas version).
    useEffect(() => {
      if (!backingFile) return
      return onFileUpdatedSignal((signal) => {
        if (signal.filePath !== backingFile) return
        const current = (editor.getShape(shape.id) as any)?.props?.text ?? ''
        if (signal.content === current) { setBackingSyncState('synced'); return }
        setBackingSyncState('stale')
        // Divergence detected — split: update this note with the file version,
        // create a sibling with the canvas version.
        const bounds = editor.getShapePageBounds(shape.id)
        const x = bounds ? bounds.x + bounds.w + 20 : 0
        const y = bounds ? bounds.y : 0
        editor.createShape({
          type: 'math-note' as any,
          x,
          y,
          props: {
            text: current,
            color: shape.props.color || 'yellow',
            w: (shape.props as any).w || 450,
            h: (shape.props as any).h || 200,
          },
          meta: { ...shape.meta, splitFrom: shape.id, splitAt: Date.now() },
        })
        editor.updateShape({
          id: shape.id,
          type: 'math-note' as any,
          props: { text: signal.content },
        })
      })
    }, [backingFile, shape.id, editor])

    // Memoize KaTeX + markdown rendering — only re-parse when text or registered images change
    const renderedHtmlBase = useMemo(
      () => {
        const t = shape.props.text || ''
        if (!hasMath(t) && !hasMarkdown(t) && !t.includes('[->') && !t.includes('@')) return null
        let html = renderMarkdownMath(t)
        if (Object.keys(labelRegions).length > 0) {
          html = linkifyArrowRefs(html, labelRegions)
          html = linkifyAtRefs(html, labelRegions)
        }
        return html
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [shape.props.text, imgVersion, labelRegions],
    )

    // Inject bullet-selected class into <li> elements that have active bullets
    const renderedHtml = useMemo(() => {
      if (!renderedHtmlBase) return renderedHtmlBase
      const myBullets = activeBullets.filter(b => b.noteShapeId === shape.id)
      if (myBullets.length === 0) return renderedHtmlBase
      const selectedIndices = new Set(myBullets.map(b => b.bulletIndex))
      let count = 0
      return renderedHtmlBase.replace(/<li>/g, (match) => {
        if (selectedIndices.has(count++)) return '<li class="bullet-selected">'
        return match
      })
    }, [renderedHtmlBase, activeBullets, shape.id])

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

      // Voice accumulator state — declared here so the updateListener can
      // reference them by closure even though they're mutated later.
      let voiceAnchorPos: number | null = null
      let lastVoiceLen = 0
      let voiceFilling = false  // true while onVoiceUpdate is dispatching

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
            // Cursor moved or text typed by the user (not voice) — interrupt the
            // current speech session so the next one starts from the new position.
            // Mirrors the textarea onEdit → enterEdit() path in voice.mjs.
            if (!voiceFilling && (update.selectionSet || update.docChanged)) {
              voiceAnchorPos = null
              lastVoiceLen = 0
              notifyAccumulatorCursorMoved()
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
      // Move cursor to end of content so the user can continue typing after existing text.
      // On double-click edit of a note, CodeMirror's own click handler repositions the cursor
      // to the clicked location — this just sets the initial position sensibly.
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        scrollIntoView: true,
      })

      // Wire voice accumulator: Right Shift → dictate into this note.
      // voiceAnchorPos/lastVoiceLen/voiceFilling are declared above (before EditorState.create)
      // so the updateListener closure can reference them.
      const onVoiceUpdate = (text: string) => {
        const v = cmViewRef.current
        if (!v) return
        if (voiceAnchorPos === null) {
          // First update of this recording session: snapshot cursor position
          voiceAnchorPos = v.state.selection.main.head
          lastVoiceLen = 0
        }
        const from = voiceAnchorPos
        const to = voiceAnchorPos + lastVoiceLen
        voiceFilling = true
        v.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from + text.length },
        })
        voiceFilling = false
        lastVoiceLen = text.length
        // EditorView.updateListener fires and saves to shape props
      }
      const onVoiceStop = () => {
        // Recording stopped — next session starts a fresh anchor
        voiceAnchorPos = null
        lastVoiceLen = 0
      }
      setVoiceAccumulator(onVoiceUpdate, null, onVoiceStop, 'note')

      // Re-register accumulator whenever CodeMirror regains focus.
      // If the chat shape called setVoiceTarget (which calls hardResetVoice and clears
      // _accumulator), we need to reclaim it when the note is focused again — the
      // isEditing effect won't re-fire since the note stays in edit mode throughout.
      const onCmFocus = () => setVoiceAccumulator(onVoiceUpdate, null, onVoiceStop, 'note')
      view.dom.addEventListener('focus', onCmFocus, true)

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
        view.dom.removeEventListener('focus', onCmFocus, true)
        container.removeEventListener('keydown', captureTab, true)
        clearVoiceAccumulator(onVoiceUpdate)
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

    // Click handler for [->label] doc-link spans
    const handleDocLinkClick = useCallback((e: React.MouseEvent) => {
      const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
      if (!target || !pageDoc) return
      if (target.classList.contains('doc-link-unresolved')) return
      const page = parseInt(target.dataset.refPage || '')
      const yTop = parseFloat(target.dataset.refYTop || '')
      if (isNaN(page)) return
      const resolved: ResolvedRef = { page, pdfY: !isNaN(yTop) ? yTop : undefined }
      const canvasPos = refToCanvas(resolved, pageDoc.pages, PDF_HEIGHT)
      if (!canvasPos) return
      e.stopPropagation()
      editor.centerOnPoint(canvasPos, { animation: { duration: 300 } })
    }, [pageDoc, editor])

    const handleBulletClick = useCallback((e: React.MouseEvent): boolean => {
      if (!backingFile) return false
      const li = (e.target as HTMLElement).closest('li') as HTMLElement | null
      if (!li) return false
      const container = contentRef.current
      if (!container) return false
      // Compute tuple path: [i, j, k, ...] where each element is the index within its parent <ul>/<ol>
      const tuplePath: number[] = []
      let el: HTMLElement | null = li
      while (el && el !== container) {
        const parent = el.parentElement
        if (!parent) break
        if (el.tagName === 'LI') {
          tuplePath.unshift(Array.from(parent.children).filter(c => c.tagName === 'LI').indexOf(el))
        }
        el = parent
      }
      // Flat index for bullet-selected highlighting
      const allLis = Array.from(container.querySelectorAll('li'))
      const bulletIndex = allLis.indexOf(li)
      if (bulletIndex < 0) return false
      const text = li.textContent?.trim() || ''
      if (!text) return false

      const id = genBulletId()
      const owner = (shape.meta?.authorId as string) || undefined
      const ctx = {
        id,
        text,
        noteShapeId: shape.id,
        tuplePath,
        owner,
        backingFile,
        bulletIndex,
      }
      addBulletContext(ctx)

      const token = `«bullet:${id}»`
      setTimeout(() => {
        chatInsertBus.dispatchEvent(new CustomEvent('insert', { detail: { text: token, owner } }))
      }, 50)

      return true
    }, [backingFile, shape.id, shape.meta?.authorId])

    // Bullet clicks must intercept on pointerDown — TLDraw's capture-phase
    // listeners prevent onClick from ever firing on unselected shape content.
    const handleContentPointerDown = useCallback((e: React.PointerEvent) => {
      if (handleBulletClick(e)) {
        stopEventPropagation(e)
      }
    }, [handleBulletClick])

    const handleContentClick = useCallback((e: React.MouseEvent) => {
      handleDocLinkClick(e)
    }, [handleDocLinkClick])

    // Hover handler for [->label] doc-link spans
    const docLinkHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => {
      const el = contentRef.current
      if (!el) return
      function onMouseOver(e: MouseEvent) {
        const target = (e.target as HTMLElement).closest('.doc-link') as HTMLElement | null
        if (!target || !pageDoc) return
        if (target.classList.contains('doc-link-unresolved')) return
        if (docLinkHoverTimerRef.current) clearTimeout(docLinkHoverTimerRef.current)
        docLinkHoverTimerRef.current = setTimeout(() => {
          const page = parseInt(target.dataset.refPage || '')
          const yTop = parseFloat(target.dataset.refYTop || '')
          if (isNaN(page) || !pageDoc) return
          const pageIdx = page - 1
          if (pageIdx < 0 || pageIdx >= pageDoc.pages.length) return
          const pageBounds = pageDoc.pages[pageIdx].bounds
          const REGION_H = pageBounds.height * 0.3
          let cy: number
          if (!isNaN(yTop)) {
            const scale = pageBounds.height / PDF_HEIGHT
            cy = pageBounds.y + yTop * scale
          } else {
            cy = pageBounds.y + pageBounds.height / 2
          }
          const bounds = { x: pageBounds.x, y: cy - REGION_H / 2, w: pageBounds.width, h: REGION_H }
          const chipRect = target.getBoundingClientRect()
          const label = target.textContent?.trim() || `p.${page}`
          window.dispatchEvent(new CustomEvent('annotation-viewer-show', {
            detail: { bounds, shapeIds: [], label, chipRect: { left: chipRect.left, top: chipRect.top, right: chipRect.right, bottom: chipRect.bottom, width: chipRect.width, height: chipRect.height } }
          }))
        }, 800)
      }
      function onMouseOut(e: MouseEvent) {
        const target = e.target as HTMLElement
        if (!target.closest('.doc-link')) return
        const related = e.relatedTarget as HTMLElement | null
        if (related?.closest('.annotation-viewer')) return
        if (docLinkHoverTimerRef.current) clearTimeout(docLinkHoverTimerRef.current)
        window.dispatchEvent(new CustomEvent('annotation-viewer-hide'))
      }
      el.addEventListener('mouseover', onMouseOver)
      el.addEventListener('mouseout', onMouseOut)
      return () => {
        el.removeEventListener('mouseover', onMouseOver)
        el.removeEventListener('mouseout', onMouseOut)
        if (docLinkHoverTimerRef.current) clearTimeout(docLinkHoverTimerRef.current)
      }
    }, [pageDoc, editor])

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
          onPointerDown={stopIfNotPenTouch(editor, isEditing)}
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
            <span>
              {backingFile && <span title={backingFile} style={{
                opacity: 0.7,
                marginRight: 4,
                color: backingSyncState === 'synced' ? '#4a9' : backingSyncState === 'pushing' ? '#aa7' : '#c55',
              }}>{backingSyncState === 'synced' ? '⇄' : backingSyncState === 'pushing' ? '⇄' : '⇉'}</span>}
              {useVim ? `-- ${vimMode.toUpperCase()} --` : ''}
            </span>
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
              .math-note-prose .doc-link { color: #7c3aed; cursor: pointer; border-bottom: 1px dotted #7c3aed; transition: opacity 0.15s; }
              .math-note-prose .doc-link:hover { opacity: 0.7; }
              .math-note-prose .doc-link-unresolved { color: inherit; opacity: 0.45; border-bottom-style: dashed; cursor: default; }
              .math-note-prose .ref-chip { font-size: 0.9em; padding: 0 2px; border-radius: 2px; }
              .math-note-prose .ref-chip-broken { color: #dc2626; opacity: 0.7; border-bottom: 1px dashed #dc2626; cursor: default; }
              .math-note-prose.tappable-bullets li { cursor: pointer; border-radius: 4px; padding: 2px 4px; margin: -2px -4px; transition: background-color 0.15s; }
              .math-note-prose.tappable-bullets li:hover { background-color: rgba(124, 58, 237, 0.08); }
              .math-note-prose.tappable-bullets li:active { background-color: rgba(124, 58, 237, 0.15); }
              .math-note-prose li.bullet-flash { animation: bullet-flash-anim 1.5s ease-out; }
              @keyframes bullet-flash-anim { 0% { background: rgba(124, 58, 237, 0.3); } 100% { background: transparent; } }
              .math-note-prose.tappable-bullets li.bullet-selected { background-color: rgba(124, 58, 237, 0.15); border-left: 3px solid rgba(124, 58, 237, 0.6); padding-left: 6px; }
            `}</style>
            <div
              className={`math-note-prose${backingFile ? ' tappable-bullets' : ''}`}
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
          onPointerDown={handleContentPointerDown}
          onClick={handleContentClick}
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
            pointerEvents: 'none',
            position: 'relative',
          }}
        >
          <div
            onMouseEnter={() => {
              if (dotHoverTimerRef.current) clearTimeout(dotHoverTimerRef.current)
              dotHoverTimerRef.current = setTimeout(() => setDotHovered(true), 600)
            }}
            onMouseLeave={() => {
              if (dotHoverTimerRef.current) clearTimeout(dotHoverTimerRef.current)
              dotHoverTimerRef.current = null
              setDotHovered(false)
            }}
            style={{ position: 'relative', pointerEvents: 'auto' }}
          >
            {/* The dot — double-click to expand, single click passes through to TLDraw for select/drag */}
            <div
              onDoubleClick={(e) => {
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
            {/* Sync state pip on collapsed dot */}
            {backingFile && backingSyncState !== 'synced' && (
              <div style={{
                position: 'absolute',
                top: -1,
                left: 8,
                width: 5,
                height: 5,
                borderRadius: '50%',
                backgroundColor: backingSyncState === 'pushing' ? '#aa7' : '#c55',
                zIndex: 11,
              }} />
            )}
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
          {/* Sync state indicator */}
          {backingFile && (
            <div
              title={`${backingFile} — ${backingSyncState}`}
              style={{
                position: 'absolute',
                top: 2,
                left: 16,
                fontSize: 12,
                lineHeight: '16px',
                color: backingSyncState === 'synced' ? '#4a9' : backingSyncState === 'pushing' ? '#aa7' : '#c55',
                userSelect: 'none',
                zIndex: 10,
                opacity: backingSyncState === 'synced' ? 0.7 : 1,
                transition: 'opacity 0.15s, color 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = backingSyncState === 'synced' ? '0.7' : '1' }}
            >{backingSyncState === 'stale' ? '⇉' : '⇄'}</div>
          )}
          {/* Inject into document — converts markdown to LaTeX via pandoc */}
          {pageDoc?.docName && shape.props.text && (
            <div
              onPointerDown={(e) => {
                stopEventPropagation(e)
                const btn = e.currentTarget as HTMLElement
                btn.textContent = '⏳'
                fetch(`/api/projects/${pageDoc!.docName}/inject`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    markdown: shape.props.text,
                    anchorLine: (shape.meta as any)?.sourceAnchor?.line,
                    anchorFile: (shape.meta as any)?.sourceAnchor?.file,
                  }),
                }).then(r => {
                  btn.textContent = r.ok ? '✓' : '✗'
                  setTimeout(() => { btn.textContent = '↧' }, 2000)
                }).catch(() => {
                  btn.textContent = '✗'
                  setTimeout(() => { btn.textContent = '↧' }, 2000)
                })
              }}
              title="Inject into document as LaTeX"
              style={{
                position: 'absolute',
                top: 3,
                right: docName ? 22 : 4,
                width: 16,
                height: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                opacity: 0.3,
                transition: 'opacity 0.15s',
                zIndex: 10,
                fontSize: '12px',
                lineHeight: '16px',
                userSelect: 'none',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.8' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.3' }}
            >↧</div>
          )}
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
