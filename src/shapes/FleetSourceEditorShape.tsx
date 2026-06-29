/**
 * FleetSourceEditorShape — HUD fleet shape for live source editing.
 *
 * Edits use the normal project push path so the existing build/reload pipeline
 * sees source changes as project writes, not as a separate side channel.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { ChangeSet, EditorState, Prec, Text } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands'
import { getOriginalDoc, unifiedMergeView, updateOriginalDoc } from '@codemirror/merge'
import { vim, getCM, Vim, CodeMirror as CM5 } from '@replit/codemirror-vim'
import { latex } from 'codemirror-lang-latex'
import { DocContext } from '../PanelContext'
import { PDF_HEIGHT, PDF_WIDTH } from '../layoutConstants'
import { getPref, subscribePref } from '../preferences'
import { loadLookup, type LookupData } from '../synctexLookup'
import {
  SYNCTEX_MAX_Y,
  SYNCTEX_VIEWBOX_OFFSET,
  isUsableLookupEntry,
  parseLookupLineKey,
  sourceLineToEditorCanvas,
} from '../synctexAnchor'
import { getVimMode, subscribeVimMode } from '../vimMode'
import { beginNativeSnapDrag, endNativeSnapDrag } from './fleet-utils'
import './fleet-chat.css'

const DEFAULT_W = 560
const DEFAULT_H = 520
const WRITE_DEBOUNCE_MS = 900
const SOURCE_CONTEXT_BEFORE = 28
const SOURCE_CONTEXT_AFTER = 44
const SOURCE_TRACK_INTERVAL_MS = 250
const SOURCE_TRACK_LINE_THRESHOLD = 2
const SOURCE_WHEEL_PX_PER_LINE = 18

const sourceEditorHistoryKeymap = Prec.highest(keymap.of([
  { key: 'Mod-z', run: undo, preventDefault: true },
  { key: 'Mod-y', mac: 'Mod-Shift-z', run: redo, preventDefault: true },
  { linux: 'Ctrl-Shift-z', run: redo, preventDefault: true },
]))

const sourceEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--text-bright, #c0c0d4)',
  },
  '.cm-scroller': {
    fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
    fontSize: 'calc(var(--fleet-base-font, 12px) - 1px)',
    lineHeight: '1.45',
  },
  '.cm-content': {
    padding: '2px 10px',
    caretColor: 'var(--text-bright, #c0c0d4)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-dim, #8888a0)',
    borderRight: '0',
    opacity: '0.45',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    paddingLeft: '0',
    paddingRight: '8px',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--text-dim, #8888a0)',
    opacity: '0.65',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(122, 158, 200, 0.28) !important',
  },
  '.cm-panels': {
    backgroundColor: 'var(--surface, #161625)',
    color: 'var(--text, #a8a8c0)',
    borderColor: 'var(--glass-5, rgba(255,255,255,0.06))',
  },
  '.cm-panels input': {
    fontFamily: '"SF Mono", Menlo, Monaco, "Courier New", monospace',
    fontSize: '11px',
  },
})

export class FleetSourceEditorShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-source-editor' as const
  static override props = {
    w: T.number,
    h: T.number,
    file: T.string,
    line: T.number,
    title: T.string,
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, file: '', line: 1, title: 'Source', userId: '', deviceId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override onTranslateStart = () => beginNativeSnapDrag(this.editor)
  override onTranslateEnd = () => endNativeSnapDrag(this.editor)
  override onTranslateCancel = () => endNativeSnapDrag(this.editor)

  component(shape: any) {
    return (
      <HTMLContainer style={{ pointerEvents: 'all' }}>
        <FleetSourceEditorComponent shape={shape} />
      </HTMLContainer>
    )
  }

  getIndicatorPath() {
    return undefined
  }

  indicator() {
    return null
  }
}

function normalizeFile(file: string) {
  return file.replace(/^\.\//, '') || 'main.tex'
}

function getFleetStyleVars(): CSSProperties {
  return {
    '--fleet-base-font': `${getPref('fleet-font-size')}px`,
    '--fleet-chrome-alpha': String(getPref('fleet-chrome-opacity')),
    '--fleet-content-alpha': String(getPref('fleet-content-opacity')),
  } as CSSProperties
}

function useFleetStyleVars() {
  const [vars, setVars] = useState(getFleetStyleVars)
  useEffect(() => subscribePref(() => setVars(getFleetStyleVars())), [])
  return vars
}

function sourceWindowForText(text: string, centerLine: number) {
  const lines = text.split('\n')
  const targetLine = Math.max(1, Math.min(Math.floor(centerLine || 1), Math.max(1, lines.length)))
  const startLine = Math.max(1, targetLine - SOURCE_CONTEXT_BEFORE)
  const endLine = Math.min(lines.length, targetLine + SOURCE_CONTEXT_AFTER)
  return {
    startLine,
    endLine,
    targetLine,
    text: lines.slice(startLine - 1, endLine).join('\n'),
  }
}

function lineStatusText(file: string, sourceWindow: { targetLine: number }) {
  void file
  return `L${sourceWindow.targetLine}`
}

const VIM_REGEX_HINT_RE = /\s*\((?:set (?:no)?pcre to use (?:Vim|vim) regexps?|(?:JavaScript|Vim) regexp: set (?:no)?pcre)\)/g

function stripVimRegexHints(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Node[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode)
  for (const node of textNodes) {
    const next = node.textContent?.replace(VIM_REGEX_HINT_RE, '') ?? ''
    if (next !== node.textContent) node.textContent = next
  }
}

function hasConflictMarkers(text: string) {
  return text.includes('<<<<<<<') || text.includes('=======') || text.includes('>>>>>>>')
}

type ConflictSide = 'ours' | 'theirs'

function replaceConflictMarkers(text: string, side: ConflictSide) {
  return text.replace(
    /^<<<<<<<[^\n]*(?:\n|$)([\s\S]*?)^=======(?:\n|$)([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm,
    (_match, ours, theirs) => side === 'ours' ? ours : theirs,
  )
}

function conflictMergeDocs(text: string, side: ConflictSide) {
  if (!hasConflictMarkers(text)) return null
  const otherSide = side === 'ours' ? 'theirs' : 'ours'
  return {
    currentText: replaceConflictMarkers(text, side),
    originalText: replaceConflictMarkers(text, otherSide),
  }
}

function boundsValue(bounds: any, key: 'x' | 'y' | 'w' | 'h') {
  if (!bounds) return 0
  if (key === 'x') return Number(bounds.x ?? bounds.minX ?? 0)
  if (key === 'y') return Number(bounds.y ?? bounds.minY ?? 0)
  if (key === 'w') return Number(bounds.w ?? bounds.width ?? 0)
  return Number(bounds.h ?? bounds.height ?? 0)
}

function viewportValue(viewport: any, key: 'minX' | 'minY' | 'maxX' | 'maxY' | 'width' | 'height') {
  if (!viewport) return 0
  if (key === 'minX') return Number(viewport.minX ?? viewport.x ?? 0)
  if (key === 'minY') return Number(viewport.minY ?? viewport.y ?? 0)
  if (key === 'maxX') return Number(viewport.maxX ?? ((viewport.x ?? viewport.minX ?? 0) + (viewport.w ?? viewport.width ?? 0)))
  if (key === 'maxY') return Number(viewport.maxY ?? ((viewport.y ?? viewport.minY ?? 0) + (viewport.h ?? viewport.height ?? 0)))
  if (key === 'width') return Number(viewport.width ?? viewport.w ?? ((viewport.maxX ?? 0) - (viewport.minX ?? 0)))
  return Number(viewport.height ?? viewport.h ?? ((viewport.maxY ?? 0) - (viewport.minY ?? 0)))
}

function sourceAnchorForViewport(mainEditor: any, lookup: LookupData | null) {
  if (!mainEditor || !lookup) return null
  const viewport = mainEditor.getViewportPageBounds?.()
  if (!viewport) return null
  const minX = viewportValue(viewport, 'minX')
  const minY = viewportValue(viewport, 'minY')
  const maxX = viewportValue(viewport, 'maxX')
  const maxY = viewportValue(viewport, 'maxY')
  const centerX = minX + viewportValue(viewport, 'width') / 2
  const centerY = minY + viewportValue(viewport, 'height') / 2
  const pageShapes = (mainEditor.getCurrentPageShapes?.() || [])
    .filter((s: any) => s?.type === 'svg-page' && typeof s?.props?.pageIndex === 'number')

  let bestPage: { shape: any; bounds: any; score: number } | null = null
  for (const shape of pageShapes) {
    const bounds = mainEditor.getShapePageBounds?.(shape.id)
    const x = boundsValue(bounds, 'x')
    const y = boundsValue(bounds, 'y')
    const w = boundsValue(bounds, 'w')
    const h = boundsValue(bounds, 'h')
    if (!w || !h) continue
    const intersects = x + w > minX && x < maxX && y + h > minY && y < maxY
    if (!intersects) continue
    const clampedX = Math.max(x, Math.min(centerX, x + w))
    const clampedY = Math.max(y, Math.min(centerY, y + h))
    const score = Math.hypot(centerX - clampedX, centerY - clampedY)
    if (!bestPage || score < bestPage.score) bestPage = { shape, bounds, score }
  }
  if (!bestPage) return null

  const pageNum = bestPage.shape.props.pageIndex + 1
  const pageY = boundsValue(bestPage.bounds, 'y')
  const pageH = boundsValue(bestPage.bounds, 'h')
  const localY = Math.max(0, Math.min(centerY - pageY, pageH))
  const pdfY = Math.max(0, Math.min(SYNCTEX_MAX_Y, localY / (pageH / PDF_HEIGHT) - SYNCTEX_VIEWBOX_OFFSET))
  let bestLine: { file: string; line: number; dist: number } | null = null
  for (const [key, entry] of Object.entries(lookup.lines || {})) {
    if (entry.page !== pageNum) continue
    if (!isUsableLookupEntry(entry)) continue
    const parsed = parseLookupLineKey(key, lookup)
    if (!Number.isFinite(parsed.line)) continue
    const dist = Math.abs(entry.y - pdfY)
    if (!bestLine || dist < bestLine.dist) bestLine = { ...parsed, dist }
  }
  return bestLine ? { file: bestLine.file, line: bestLine.line, page: pageNum } : null
}

function centerDocumentOnSourceLine(mainEditor: any, lookup: LookupData | null, file: string, line: number) {
  const entry = sourceLineToEditorCanvas(mainEditor, lookup, file, line)
  if (!mainEditor || !entry) return null
  const camera = mainEditor.getCamera?.() || { x: 0, y: 0, z: 1 }
  const viewport = mainEditor.getViewportScreenBounds?.()
  const viewportH = Number(viewport?.h ?? viewport?.height ?? window.innerHeight)
  mainEditor.setCamera?.({
    x: camera.x,
    y: -entry.canvasY + viewportH / (2 * camera.z),
    z: camera.z,
  }, { animation: { duration: 0 } })
  return entry
}

type SourceCursorLaserMark = {
  strokes: Array<{ x1: number; y1: number; x2: number; y2: number }>
  line: number
}

type SourceCursorPdfSpan = {
  page: number
  line: number
  xStart: number
  xEnd: number
  y: number
}

type SourceCursorPageShape = {
  id: string
  type?: string
  props?: { pageIndex?: number }
}

type SourceCursorEditor = {
  getCurrentPageShapes?: () => SourceCursorPageShape[]
  getShapePageBounds?: (id: string) => unknown
  scribbles?: {
    startSession: (options: Record<string, unknown>) => string
    addScribbleToSession: (sessionId: string, options: Record<string, unknown>) => { id: string }
    addPointToSession: (sessionId: string, scribbleId: string, x: number, y: number, z: number) => void
    clearSession?: (sessionId: string) => void
    complete?: (scribbleId: string) => void
    extendSession?: (sessionId: string) => void
    tick?: (ms: number) => void
  }
}

function sourceCursorEditor(fallback: unknown): SourceCursorEditor {
  return ((typeof window !== 'undefined' && (window as Window & { __tldraw_editor__?: SourceCursorEditor }).__tldraw_editor__) || fallback || {}) as SourceCursorEditor
}

function FleetSourceEditorComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const styleVars = useFleetStyleVars()
  const useVim = useSyncExternalStore(subscribeVimMode, getVimMode)
  const containerRef = useRef<HTMLDivElement>(null)
  const cmHostRef = useRef<HTMLDivElement>(null)
  const cmViewRef = useRef<EditorView | null>(null)
  const cmKeydownCleanupRef = useRef<(() => void) | null>(null)
  const cmPanelCleanupRef = useRef<(() => void) | null>(null)
  const writeTimerRef = useRef<number | null>(null)
  const saveSeqRef = useRef(0)
  const [file, setFile] = useState(() => normalizeFile(shape.props.file))
  const [trackedAnchor, setTrackedAnchor] = useState(() => ({
    file: normalizeFile(shape.props.file),
    line: Math.max(1, Number(shape.props.line || 1)),
    page: 0,
  }))
  const [vimMode, setVimModeState] = useState('normal')
  const [status, setStatus] = useState<'loading' | 'ready' | 'dirty' | 'syncing' | 'synced' | 'error'>('loading')
  const [statusText, setStatusText] = useState('Loading source...')
  const [conflictFiles, setConflictFiles] = useState<string[]>([])
  const [sourceHasConflictMarkers, setSourceHasConflictMarkers] = useState(false)
  const [conflictMergeActive, setConflictMergeActive] = useState(false)
  const statusRef = useRef(status)
  const lookupRef = useRef<LookupData | null>(null)
  const conflictFilesRef = useRef<string[]>([])
  const conflictRawTextRef = useRef('')
  const conflictSideRef = useRef<ConflictSide>('ours')
  const savedTextRef = useRef('')
  const fullSourceRef = useRef('')
  const sourceWindowRef = useRef({ startLine: 1, endLine: 1, targetLine: 1, text: '' })
  const vimModeRef = useRef(vimMode)
  const laserSessionRef = useRef<string | null>(null)
  const cursorLaserSeqRef = useRef(0)

  useEffect(() => { statusRef.current = status }, [status])
  useEffect(() => { vimModeRef.current = vimMode }, [vimMode])
  useEffect(() => { conflictFilesRef.current = conflictFiles }, [conflictFiles])

  const pdfSpansToCanvasMark = (spans: SourceCursorPdfSpan[], sourceLine: number): SourceCursorLaserMark | null => {
    const mainEditor = sourceCursorEditor(editor)
    const strokes: SourceCursorLaserMark['strokes'] = []
    const pageShapes = (mainEditor?.getCurrentPageShapes?.() || [])
      .filter((s) => s?.type === 'svg-page' && typeof s?.props?.pageIndex === 'number')
    for (const span of spans) {
      const pageShape = pageShapes.find((s) => Number(s.props?.pageIndex) + 1 === span.page)
      if (!pageShape) continue
      const bounds = mainEditor.getShapePageBounds?.(pageShape.id)
      const pageX = boundsValue(bounds, 'x')
      const pageY = boundsValue(bounds, 'y')
      const pageW = boundsValue(bounds, 'w')
      const pageH = boundsValue(bounds, 'h')
      if (!pageW || !pageH) continue
      const scaleX = pageW / PDF_WIDTH
      const scaleY = pageH / PDF_HEIGHT
      const x1 = pageX + (span.xStart + SYNCTEX_VIEWBOX_OFFSET) * scaleX
      const x2Raw = pageX + (span.xEnd + SYNCTEX_VIEWBOX_OFFSET) * scaleX
      const minW = 8 * scaleX
      const x2 = Math.abs(x2Raw - x1) < minW ? x1 + minW : x2Raw
      const y = pageY + (span.y + SYNCTEX_VIEWBOX_OFFSET) * scaleY + 4 * scaleY
      strokes.push({
        x1,
        x2,
        y1: y,
        y2: y,
      })
    }
    if (strokes.length === 0) return null
    return { strokes, line: sourceLine }
  }

  const computeCursorLaserMark = async (sourceFile: string, sourceLine: number, sourceColumn: number, seq: number) => {
    if (!doc?.docName) return null
    const res = await fetch(`/api/projects/${encodeURIComponent(doc.docName)}/source-cursor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: sourceFile, line: sourceLine, column: sourceColumn }),
    })
    if (seq !== cursorLaserSeqRef.current) return null
    if (!res.ok) return null
    const payload = await res.json()
    if (!Array.isArray(payload?.pdfSpans)) return null
    return pdfSpansToCanvasMark(payload.pdfSpans, sourceLine)
  }

  const clearCursorLaser = () => {
    const mainEditor = sourceCursorEditor(editor)
    const sessionId = laserSessionRef.current
    if (!sessionId) return
    laserSessionRef.current = null
    try {
      mainEditor?.scribbles?.clearSession?.(sessionId)
      mainEditor?.scribbles?.tick?.(16)
    } catch {
      laserSessionRef.current = null
    }
  }

  const emitCursorLaser = (mark: SourceCursorLaserMark | null) => {
    const mainEditor = sourceCursorEditor(editor)
    clearCursorLaser()
    if (!mainEditor?.scribbles || !mark) return
    try {
      const sessionId = mainEditor.scribbles.startSession({
        selfConsume: false,
        idleTimeoutMs: 5000,
        fadeMode: 'grouped',
        fadeEasing: 'ease-in',
        fadeDurationMs: 900,
      })
      const scribble = mainEditor.scribbles.addScribbleToSession(sessionId, {
        color: 'laser',
        opacity: 0.85,
        size: 6,
        taper: false,
      })
      for (const stroke of mark.strokes) {
        const segments = 5
        for (let i = 0; i < segments; i += 1) {
          const t = i / (segments - 1)
          mainEditor.scribbles.addPointToSession(
            sessionId,
            scribble.id,
            stroke.x1 + (stroke.x2 - stroke.x1) * t,
            stroke.y1 + (stroke.y2 - stroke.y1) * t + Math.sin(t * Math.PI) * 1.5,
            0.5,
          )
          mainEditor.scribbles.tick?.(16)
        }
      }
      mainEditor.scribbles.complete?.(scribble.id)
      mainEditor.scribbles.extendSession?.(sessionId)
      laserSessionRef.current = sessionId
    } catch {
      clearCursorLaser()
    }
  }

  const updateCursorLaserFromView = (view: EditorView) => {
    try {
      const seq = cursorLaserSeqRef.current + 1
      cursorLaserSeqRef.current = seq
      const docLine = view.state.doc.lineAt(view.state.selection.main.head)
      const sourceLine = docLine.number
      const sourceColumn = view.state.selection.main.head - docLine.from
      void computeCursorLaserMark(file, sourceLine, sourceColumn, seq)
        .then(mark => {
          if (seq === cursorLaserSeqRef.current) emitCursorLaser(mark)
        })
        .catch(() => {
          if (seq === cursorLaserSeqRef.current) clearCursorLaser()
        })
    } catch {
      clearCursorLaser()
    }
  }

  useEffect(() => {
    return () => clearCursorLaser()
  }, [])

  useEffect(() => {
    if (!doc?.docName) return
    let cancelled = false
    async function resolveFile() {
      if (shape.props.file) {
        setFile(normalizeFile(shape.props.file))
        return
      }
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(doc!.docName)}`)
        if (!res.ok) throw new Error(`project ${res.status}`)
        const info = await res.json()
        const nextFile = normalizeFile(info?.mainFile || 'main.tex')
        if (cancelled) return
        setFile(nextFile)
        setTrackedAnchor(prev => ({ ...prev, file: nextFile }))
        editor.updateShape({
          id: shape.id,
          type: 'fleet-source-editor' as any,
          props: { file: nextFile, title: nextFile },
        })
      } catch {
        if (!cancelled) {
          setFile('main.tex')
          setTrackedAnchor(prev => ({ ...prev, file: 'main.tex' }))
        }
      }
    }
    resolveFile()
    return () => { cancelled = true }
  }, [doc?.docName, editor, shape.id, shape.props.file])

  useEffect(() => {
    if (!doc?.docName) return
    let cancelled = false
    async function loadProjectConflictState() {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(doc!.docName)}`)
        if (!res.ok) throw new Error(`project ${res.status}`)
        const info = await res.json()
        if (cancelled) return
        const files = info?.overleafSyncStatus === 'conflict' && Array.isArray(info?.overleafConflictFiles)
          ? info.overleafConflictFiles.map(normalizeFile)
          : []
        setConflictFiles(files)
      } catch {
        if (!cancelled) setConflictFiles([])
      }
    }
    void loadProjectConflictState()
    const interval = window.setInterval(loadProjectConflictState, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [doc?.docName])

  useEffect(() => {
    if (!doc?.docName) return
    let cancelled = false
    let lookup: LookupData | null = null
    void loadLookup(doc.docName).then((data) => {
      lookup = data
      lookupRef.current = data
    })
    const track = () => {
      if (cancelled || statusRef.current === 'dirty' || statusRef.current === 'syncing') return
      const mainEditor = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
      const next = sourceAnchorForViewport(mainEditor, lookup)
      if (!next) return
      setTrackedAnchor(prev => {
        if (prev.file === next.file && Math.abs(prev.line - next.line) < SOURCE_TRACK_LINE_THRESHOLD) return prev
        return next
      })
    }
    const interval = window.setInterval(track, SOURCE_TRACK_INTERVAL_MS)
    const unsubscribe = (((typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor)?.store?.listen?.(track, { source: 'all', scope: 'all' })) || undefined
    const raf = window.requestAnimationFrame(track)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.cancelAnimationFrame(raf)
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [doc?.docName, editor])

  useEffect(() => {
    return () => {
      if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
    }
  }, [])

  const writeSource = async (nextFullText: string, seq: number) => {
    if (!doc?.docName || !file) return
    if (nextFullText === savedTextRef.current) {
      setStatus('ready')
      setStatusText(lineStatusText(file, sourceWindowRef.current))
      return
    }
    setStatus('syncing')
    setStatusText('Syncing...')
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(doc.docName)}/source/${encodeURIComponent(file)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: nextFullText,
          editedBy: shape.props.userId || shape.props.deviceId || 'fleet-source-editor',
        }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok || payload?.ok === false) throw new Error(payload?.error || `sync ${res.status}`)
      if (seq !== saveSeqRef.current) return
      savedTextRef.current = nextFullText
      fullSourceRef.current = nextFullText
      setSourceHasConflictMarkers(hasConflictMarkers(nextFullText))
      sourceWindowRef.current = sourceWindowForText(nextFullText, sourceWindowRef.current.targetLine)
      setStatus('synced')
      setStatusText(payload?.building ? 'Synced; build queued' : 'Synced')
    } catch (err: any) {
      if (seq !== saveSeqRef.current) return
      setStatus('error')
      setStatusText(err?.message || 'Sync failed')
    }
  }

  const queueWrite = (text: string) => {
    saveSeqRef.current += 1
    const seq = saveSeqRef.current
    if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
    setStatus('dirty')
    setStatusText('Sync pending...')
    writeTimerRef.current = window.setTimeout(() => {
      writeTimerRef.current = null
      void writeSource(text, seq)
    }, WRITE_DEBOUNCE_MS)
  }

  const runEditorUndoRedo = (view: EditorView, redoRequested: boolean) => {
    if (useVim) {
      const cm = getCM(view)
      if (!cm) return false
      const wasInsert = vimModeRef.current === 'insert'
      Vim.handleKey(cm, '<Esc>', 'user')
      Vim.handleKey(cm, redoRequested ? '<C-r>' : 'u', 'user')
      if (wasInsert) Vim.handleKey(cm, 'i', 'user')
      const currentText = view.state.doc.toString()
      fullSourceRef.current = currentText
      setSourceHasConflictMarkers(hasConflictMarkers(currentText))
      return true
    }

    const didRun = redoRequested ? redo(view) : undo(view)
    if (!didRun) return false
    const currentText = view.state.doc.toString()
    fullSourceRef.current = currentText
    setSourceHasConflictMarkers(hasConflictMarkers(currentText))
    return true
  }

  useEffect(() => {
    if (!doc?.docName || !cmHostRef.current || !file) return
    let cancelled = false

    async function loadSource() {
      if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
      writeTimerRef.current = null
      setStatus('loading')
      setStatusText(`Loading ${file}...`)
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(doc!.docName)}/source/${encodeURIComponent(file)}`)
	        if (!res.ok) throw new Error(`source ${res.status}`)
	        const text = await res.text()
	        if (cancelled || !cmHostRef.current) return
	
	        cmKeydownCleanupRef.current?.()
	        cmKeydownCleanupRef.current = null
	        cmPanelCleanupRef.current?.()
	        cmPanelCleanupRef.current = null
	        cmViewRef.current?.destroy()
        const mergeDocs = conflictMergeDocs(text, conflictSideRef.current)
        const editorText = mergeDocs?.currentText ?? text
        conflictRawTextRef.current = mergeDocs ? text : ''
        setConflictMergeActive(!!mergeDocs)
        const sourceWindow = sourceWindowForText(editorText, Math.max(1, Number(trackedAnchor.line || shape.props.line || 1)))
        fullSourceRef.current = editorText
        sourceWindowRef.current = sourceWindow
        savedTextRef.current = text
        setSourceHasConflictMarkers(hasConflictMarkers(editorText))
        const startState = EditorState.create({
          doc: editorText,
          extensions: [
            sourceEditorHistoryKeymap,
            ...(useVim ? [vim()] : []),
            lineNumbers(),
            history({ minDepth: 10000 }),
            latex(),
            ...(mergeDocs
              ? [unifiedMergeView({
                  original: mergeDocs.originalText,
                  mergeControls: false,
                  gutter: true,
                  allowInlineDiffs: true,
                  syntaxHighlightDeletions: false,
                  diffConfig: { scanLimit: 1000, timeout: 100 },
                })]
              : []),
            EditorView.lineWrapping,
            sourceEditorTheme,
	            EditorView.updateListener.of((update) => {
	              if (update.selectionSet) updateCursorLaserFromView(update.view)
	              if (!update.docChanged) return
	              const currentText = update.state.doc.toString()
	              fullSourceRef.current = currentText
              setSourceHasConflictMarkers(hasConflictMarkers(currentText))
              if (currentText === savedTextRef.current) {
                if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
                writeTimerRef.current = null
                setStatus('ready')
                setStatusText(lineStatusText(file, sourceWindowRef.current))
                return
              }
              if (conflictFilesRef.current.includes(normalizeFile(file))) {
                if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
                writeTimerRef.current = null
                setStatus('dirty')
                setStatusText(hasConflictMarkers(currentText) ? 'Resolve conflict markers' : 'Ready to resolve')
                return
              }
              queueWrite(currentText)
            }),
            keymap.of([...defaultKeymap, ...historyKeymap]),
          ],
        })
        const view = new EditorView({ state: startState, parent: cmHostRef.current })
        const handleNativeKeydown = (event: KeyboardEvent) => {
          const key = String(event.key || '').toLowerCase()
          const mod = event.metaKey || event.ctrlKey
          if (!mod || event.altKey || (key !== 'z' && key !== 'y')) return
          event.preventDefault()
          event.stopPropagation()
          runEditorUndoRedo(view, key === 'y' || event.shiftKey)
        }
        view.dom.addEventListener('keydown', handleNativeKeydown, { capture: true })
	        cmKeydownCleanupRef.current = () => {
	          view.dom.removeEventListener('keydown', handleNativeKeydown, { capture: true })
	        }
	        stripVimRegexHints(view.dom)
	        const panelObserver = new MutationObserver(() => stripVimRegexHints(view.dom))
	        panelObserver.observe(view.dom, { childList: true, subtree: true, characterData: true })
	        cmPanelCleanupRef.current = () => panelObserver.disconnect()
	        cmViewRef.current = view
        setVimModeState(useVim ? 'normal' : '')
        const cm = useVim ? getCM(view) : null
        if (cm) {
          cm.setOption('pcre', true)
          CM5.on(cm, 'vim-mode-change', (e: any) => setVimModeState(e.mode || 'normal'))
          Vim.defineEx('write', 'w', () => {
            const current = cmViewRef.current?.state.doc.toString()
            if (current !== undefined) queueWrite(current)
          })
        }
	        setStatus('ready')
	        const pageText = trackedAnchor.page ? ` p${trackedAnchor.page}` : ''
	        setStatusText(`${lineStatusText(file, sourceWindow)}${pageText}`)
	        try {
	          const targetLine = Math.max(1, Math.min(sourceWindow.targetLine, view.state.doc.lines))
	          const line = view.state.doc.line(targetLine)
	          view.dispatch({
	            selection: { anchor: line.from },
	            effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
	          })
	          updateCursorLaserFromView(view)
	        } catch {
	          clearCursorLaser()
	        }
	      } catch (err: any) {
	        if (cancelled) return
	        cmKeydownCleanupRef.current?.()
	        cmKeydownCleanupRef.current = null
	        cmPanelCleanupRef.current?.()
	        cmPanelCleanupRef.current = null
	        cmViewRef.current?.destroy()
        cmViewRef.current = null
        setStatus('error')
        setStatusText(err?.message || 'Failed to load source')
      }
    }

    loadSource()
	    return () => {
	      cancelled = true
	      cmKeydownCleanupRef.current?.()
	      cmKeydownCleanupRef.current = null
	      cmPanelCleanupRef.current?.()
	      cmPanelCleanupRef.current = null
	      cmViewRef.current?.destroy()
      cmViewRef.current = null
    }
  }, [doc?.docName, file, useVim])

	  useEffect(() => {
	    const view = cmViewRef.current
	    if (!view || !fullSourceRef.current || statusRef.current === 'dirty' || statusRef.current === 'syncing') return
    const sourceWindow = sourceWindowForText(fullSourceRef.current, trackedAnchor.line || shape.props.line || 1)
    sourceWindowRef.current = sourceWindow
    const pageText = trackedAnchor.page ? ` p${trackedAnchor.page}` : ''
    setStatusText(`${lineStatusText(file, sourceWindow)}${pageText}`)
    try {
      const targetLine = Math.max(1, Math.min(sourceWindow.targetLine, view.state.doc.lines))
      const line = view.state.doc.line(targetLine)
      view.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
      })
      updateCursorLaserFromView(view)
    } catch {
      clearCursorLaser()
    }
	  }, [file, shape.props.line, trackedAnchor.line, trackedAnchor.page])

  useEffect(() => {
    const nextFile = normalizeFile(trackedAnchor.file)
    if (nextFile && nextFile !== file && statusRef.current !== 'dirty' && statusRef.current !== 'syncing') {
      setFile(nextFile)
    }
  }, [file, trackedAnchor.file])

  const handlePointerDown = (e: any) => {
    stopEventPropagation(e)
    if (!cmHostRef.current?.contains(e.target as Node)) return
    requestAnimationFrame(() => {
      cmViewRef.current?.focus()
    })
  }
  const handleKeyDown = (e: any) => {
    if (!cmHostRef.current?.contains(e.target as Node)) return
    stopEventPropagation(e)
  }
  const handleWheel = (e: any) => {
    stopEventPropagation(e)
    const mainEditor = (typeof window !== 'undefined' && (window as any).__tldraw_editor__) || editor
    const currentLine = trackedAnchor.line || sourceWindowRef.current.targetLine || shape.props.line || 1
    const lineDelta = Math.trunc(e.deltaY / SOURCE_WHEEL_PX_PER_LINE) || (e.deltaY > 0 ? 1 : e.deltaY < 0 ? -1 : 0)
    if (!lineDelta) return
    const entry = centerDocumentOnSourceLine(mainEditor, lookupRef.current, file, currentLine + lineDelta)
    if (!entry) return
    setTrackedAnchor({ file: entry.file, line: entry.line, page: entry.page })
  }
  const currentFileConflicted = conflictFiles.includes(normalizeFile(file))
  const canResolveConflict = currentFileConflicted && !sourceHasConflictMarkers && status !== 'syncing'
  const applyConflictSide = (side: ConflictSide) => {
    const view = cmViewRef.current
    if (!view) return
    const rawText = conflictRawTextRef.current || view.state.doc.toString()
    const mergeDocs = conflictMergeDocs(rawText, side)
    if (!mergeDocs) return
    conflictSideRef.current = side
    const original = getOriginalDoc(view.state)
    const originalChanges = ChangeSet.of(
      { from: 0, to: original.length, insert: mergeDocs.originalText },
      original.length,
    )
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: mergeDocs.currentText },
      effects: updateOriginalDoc.of({
        doc: Text.of(mergeDocs.originalText.split(/\r?\n/)),
        changes: originalChanges,
      }),
    })
  }
  const resolveConflict = () => {
    const view = cmViewRef.current
    if (!view || !canResolveConflict) return
    const currentText = view.state.doc.toString()
    if (hasConflictMarkers(currentText)) return
    saveSeqRef.current += 1
    const seq = saveSeqRef.current
    if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
    writeTimerRef.current = null
    void writeSource(currentText, seq)
  }
  const showStatusBar = status === 'dirty' || status === 'syncing' || status === 'error'
  const reserveStatusBar = useVim || showStatusBar

	  return (
	    <div
	      ref={containerRef}
	      className={`fleet-shape fleet-source-editor fleet-chat-shape${reserveStatusBar ? ' fleet-source-editor-with-status' : ''}`}
      style={{ width: shape.props.w, height: shape.props.h, ...styleVars }}
      onPointerDown={handlePointerDown}
      onPointerMove={stopEventPropagation}
      onKeyDown={handleKeyDown}
      onWheel={handleWheel}
    >
      <div className="fleet-btn-group" onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="fleet-close-btn"
          onPointerUp={(e) => {
            e.stopPropagation()
            editor.deleteShapes([shape.id])
          }}
        >
          ×
        </button>
        <button
          className="fleet-layout-btn"
          onPointerUp={(e) => {
            e.stopPropagation()
            editor.setCurrentTool('select')
            editor.select(shape.id)
          }}
          title="Resize / move"
        >
          ⊞
        </button>
      </div>
      {currentFileConflicted && (
        <div className="fleet-source-editor-conflict" onPointerDown={stopEventPropagation}>
          <button type="button" onClick={() => applyConflictSide('ours')} disabled={!sourceHasConflictMarkers && !conflictMergeActive}>ours</button>
          <button type="button" onClick={() => applyConflictSide('theirs')} disabled={!sourceHasConflictMarkers && !conflictMergeActive}>theirs</button>
          <button type="button" onClick={resolveConflict} disabled={!canResolveConflict}>resolved</button>
        </div>
      )}
      {showStatusBar && (
        <div className={`fleet-source-editor-status fleet-source-editor-status-${status}`}>
          {(status === 'dirty' || status === 'syncing' || status === 'error') && <span>{statusText}</span>}
        </div>
      )}
      <div className="fleet-source-editor-body">
        {status === 'error' && (
          <div className="fleet-source-editor-error">{statusText}</div>
        )}
	        <div ref={cmHostRef} className="fleet-source-editor-cm" />
	      </div>
    </div>
  )
}
