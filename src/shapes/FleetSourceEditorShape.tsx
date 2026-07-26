/**
 * FleetSourceEditorShape — HUD fleet shape for live source editing.
 *
 * Edits use the normal project push path so the existing build/reload pipeline
 * sees source changes as project writes, not as a separate side channel.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { fleetSourceEditorProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { normalizeSourceManifest } from '../../shared/source-manifest.mjs'
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { ChangeSet, EditorState, Prec, Text } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands'
import { getOriginalDoc, unifiedMergeView, updateOriginalDoc } from '@codemirror/merge'
import { vim, getCM, Vim, CodeMirror as CM5 } from '@replit/codemirror-vim'
import { latex } from 'codemirror-lang-latex'
import { DocContext } from '../PanelContext'
import { STORE_HTTP } from '../activeConfig'
import { htmlSourceLineAnchorAtCanvasY, type HtmlSourceLineAnchor } from '../htmlSourceAnchors'
import { PDF_HEIGHT, PDF_WIDTH } from '../layoutConstants'
import { getPref, subscribePref } from '../preferences'
import { readabilityStyleVars } from '../readabilityProfile'
import { loadLookup, type LookupData } from '../synctexLookup'
import {
  SYNCTEX_MAX_Y,
  SYNCTEX_VIEWBOX_OFFSET,
  isUsableLookupEntry,
  parseLookupLineKey,
  sourceLineToEditorCanvas,
} from '../synctexAnchor'
import { shouldReuseTrackedSourceAnchor } from '../sourceCursorTracking'
import { getVimMode, subscribeVimMode } from '../vimMode'
import { clearVoiceAccumulator, notifyAccumulatorCursorMoved, setVoiceAccumulator } from '../voice.mjs'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import { beginFleetDragWithoutSnap, endFleetDragWithoutSnap } from './fleet-utils'
import './fleet-chat.css'

const DEFAULT_W = 560
const DEFAULT_H = 520
// Seconds of no typing before the editor commits on its own. This is the
// third write boundary — see AGENTS.md "Project as world". Clamped so a
// bad preference can't turn the editor back into a keystroke stream or
// swallow a write for minutes.
const MIN_IDLE_WRITE_SEC = 1
const MAX_IDLE_WRITE_SEC = 60
function idleWriteMs(): number {
  const sec = Number(getPref('source-write-idle-sec'))
  if (!Number.isFinite(sec)) return 4000
  return Math.min(MAX_IDLE_WRITE_SEC, Math.max(MIN_IDLE_WRITE_SEC, sec)) * 1000
}
const SOURCE_CONTEXT_BEFORE = 28
const SOURCE_CONTEXT_AFTER = 44
const SOURCE_TRACK_INTERVAL_MS = 250
const SOURCE_TRACK_LINE_THRESHOLD = 2
const SOURCE_WHEEL_PX_PER_LINE = 18
const SOURCE_SPLIT_LINE_WINDOW = 90
const STORE_API = STORE_HTTP.replace(/\/$/, '')

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
  static override props = fleetSourceEditorProps

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, file: '', line: 1, title: 'Source', userId: '', deviceId: '' }
  }

  override canEdit = () => false
  override canResize = () => true
  override onTranslateStart = () => beginFleetDragWithoutSnap(this.editor)
  override onTranslateEnd = () => endFleetDragWithoutSnap(this.editor)
  override onTranslateCancel = () => endFleetDragWithoutSnap(this.editor)
  override canSnap = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

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

function basename(file: string) {
  return normalizeFile(file).replace(/^.*[\\/]/, '')
}

function projectApiPath(docName: string, path: string) {
  return `${STORE_API}/api/projects/${encodeURIComponent(docName)}${path}`
}

function getFleetStyleVars(): CSSProperties {
  return readabilityStyleVars() as CSSProperties
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

type SourceSplit = {
  beforeFile: string
  beforeLine: number
  afterFile: string
  afterLine: number
}

type SourceAnchor = {
  file: string
  line: number
  page: number
  source: 'synctex' | 'html-page'
  anchored: true
}

type TrackedSourceAnchor = {
  file: string
  line: number | null
  page: number
  source?: 'synctex' | 'html-page'
  anchored: boolean
}

function canShowSourceCursorLaser(anchor: TrackedSourceAnchor | null | undefined) {
  return anchor?.source === 'synctex' && anchor.anchored && anchor.line != null
}

function sourceSplitForAnchor(lookup: LookupData | null, anchor: SourceAnchor): SourceSplit | null {
  if (!lookup || !anchor.page) return null
  const rows: Array<{ file: string; line: number; y: number }> = []
  for (const [key, entry] of Object.entries(lookup.lines || {})) {
    if (entry.page !== anchor.page) continue
    if (!isUsableLookupEntry(entry)) continue
    const parsed = parseLookupLineKey(key, lookup)
    if (!Number.isFinite(parsed.line)) continue
    rows.push({ ...parsed, y: entry.y })
  }
  rows.sort((a, b) => a.y - b.y)

  let best: { split: SourceSplit; score: number } | null = null
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]
    const next = rows[i]
    if (prev.file === next.file) continue
    const split = {
      beforeFile: prev.file,
      beforeLine: prev.line,
      afterFile: next.file,
      afterLine: next.line,
    }
    const score = anchor.file === prev.file
      ? Math.abs(anchor.line - prev.line)
      : anchor.file === next.file
        ? Math.abs(anchor.line - next.line)
        : SOURCE_SPLIT_LINE_WINDOW + 1
    if (!best || score < best.score) best = { split, score }
  }
  return best && best.score <= SOURCE_SPLIT_LINE_WINDOW ? best.split : null
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

// Pull this file's conflicted text out of a stale-base rejection. The server
// stores each file's three-way merge on the evidence record as base64; a status
// of 'conflict' means the merged text carries real git markers.
function conflictedTextFor(payload: any, sourcePath: string): string | null {
  const status = payload?.status ?? payload?.lifecycleStatus
  if (status !== 'stale-base') return null
  const classifications = payload?.evidence?.classifications
  if (!Array.isArray(classifications)) return null
  const match = classifications.find((c: any) => c?.path === sourcePath && c?.status === 'conflict' && c?.merged)
  if (!match) return null
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(match.merged), (c) => c.charCodeAt(0)))
  } catch {
    return null
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

function sourceAnchorForViewport(mainEditor: any, lookup: LookupData | null): SourceAnchor | null {
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
  return bestLine ? { file: bestLine.file, line: bestLine.line, page: pageNum, source: 'synctex' as const, anchored: true } : null
}

function htmlSourceAnchorForViewport(mainEditor: any): (HtmlSourceLineAnchor & { source: 'html-page' }) | null {
  if (!mainEditor) return null
  const viewport = mainEditor.getViewportPageBounds?.()
  if (!viewport) return null
  const minX = viewportValue(viewport, 'minX')
  const minY = viewportValue(viewport, 'minY')
  const maxX = viewportValue(viewport, 'maxX')
  const maxY = viewportValue(viewport, 'maxY')
  const centerX = minX + viewportValue(viewport, 'width') / 2
  const centerY = minY + viewportValue(viewport, 'height') / 2
  const pageShapes = (mainEditor.getCurrentPageShapes?.() || [])
    .filter((s: any) => s?.type === 'html-page' && typeof s?.props?.source === 'string' && s.props.source)

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
  const anchor = htmlSourceLineAnchorAtCanvasY(bestPage.shape, bestPage.bounds, centerY)
  return anchor ? { ...anchor, source: 'html-page' as const } : null
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
  const secondaryCmHostRef = useRef<HTMLDivElement>(null)
  const secondaryCmViewRef = useRef<EditorView | null>(null)
  const cmKeydownCleanupRef = useRef<(() => void) | null>(null)
  const cmPanelCleanupRef = useRef<(() => void) | null>(null)
  const writeTimerRef = useRef<number | null>(null)
  const secondaryWriteTimerRef = useRef<number | null>(null)
  const saveSeqRef = useRef(0)
  const secondarySaveSeqRef = useRef(0)
  const [file, setFile] = useState(() => normalizeFile(shape.props.file))
  const [sourceSplit, setSourceSplit] = useState<SourceSplit | null>(null)
  const [trackedAnchor, setTrackedAnchor] = useState(() => ({
    file: normalizeFile(shape.props.file),
    line: Math.max(1, Number(shape.props.line || 1)),
    page: 0,
    anchored: true,
  } as TrackedSourceAnchor))
  const trackedAnchorRef = useRef(trackedAnchor)
  const [vimMode, setVimModeState] = useState('normal')
  const [status, setStatus] = useState<'loading' | 'ready' | 'dirty' | 'syncing' | 'synced' | 'error'>('loading')
  const [statusText, setStatusText] = useState('Loading source...')
  // Conflicts have a source. `serverConflictFiles` is what the project reports
  // (today: Overleaf's); `heldConflictFile` is the one this editor is holding
  // right now from its own rejected write. They are separate because the project
  // poll replaces its own list wholesale and would otherwise wipe ours. When the
  // server represents conflicts per peer, the second collapses into the first.
  const [serverConflictFiles, setServerConflictFiles] = useState<string[]>([])
  const [heldConflictFile, setHeldConflictFile] = useState<string | null>(null)
  const conflictFiles = useMemo(
    () => (heldConflictFile && !serverConflictFiles.includes(heldConflictFile)
      ? [...serverConflictFiles, heldConflictFile]
      : serverConflictFiles),
    [serverConflictFiles, heldConflictFile],
  )
  const [sourceHasConflictMarkers, setSourceHasConflictMarkers] = useState(false)
  const [conflictMergeActive, setConflictMergeActive] = useState(false)
  const statusRef = useRef(status)
  const lookupRef = useRef<LookupData | null>(null)
  const conflictFilesRef = useRef<string[]>([])
  const conflictRawTextRef = useRef('')
  const conflictSideRef = useRef<ConflictSide>('ours')
  const savedTextRef = useRef('')
  const secondarySavedTextRef = useRef('')
  const fullSourceRef = useRef('')
  const secondaryFullSourceRef = useRef('')
  const sourceFilesRef = useRef<string[] | null>(null)
  const sourceFilesPromiseRef = useRef<Promise<string[]> | null>(null)
  const projectInfoRef = useRef<any | null>(null)
  const sourceWindowRef = useRef({ startLine: 1, endLine: 1, targetLine: 1, text: '' })
  const vimModeRef = useRef(vimMode)
  const laserSessionRef = useRef<string | null>(null)
  const cursorLaserSeqRef = useRef(0)
  const voiceSessionRef = useRef<{ view: EditorView; from: number; to: number } | null>(null)
  const voiceApplyingRef = useRef(false)
  const voiceUpdateRef = useRef<((text: string) => void) | null>(null)
  const voiceStopRef = useRef<(() => void) | null>(null)
  const queueWriteRef = useRef<((text: string) => void) | null>(null)
  const flushWriteRef = useRef<(() => void) | null>(null)

  if (!voiceUpdateRef.current) {
    voiceUpdateRef.current = (text: string) => {
      const session = voiceSessionRef.current
      if (!session) return
      const view = session.view
      const insert = String(text || '')
      const from = Math.max(0, Math.min(session.from, view.state.doc.length))
      const to = Math.max(from, Math.min(session.to, view.state.doc.length))
      voiceApplyingRef.current = true
      try {
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
        })
        voiceSessionRef.current = { view, from, to: from + insert.length }
      } finally {
        requestAnimationFrame(() => { voiceApplyingRef.current = false })
      }
    }
  }
  if (!voiceStopRef.current) {
    voiceStopRef.current = () => {
      voiceSessionRef.current = null
    }
  }

  const activateVoiceEditor = (view: EditorView | null, label = 'editor') => {
    if (!view) return
    const head = view.state.selection.main.head
    voiceSessionRef.current = { view, from: head, to: head }
    view.focus()
    setVoiceAccumulator(voiceUpdateRef.current!, null, voiceStopRef.current!, label)
  }

  useEffect(() => {
    const onUpdate = voiceUpdateRef.current
    return () => {
      if (onUpdate) clearVoiceAccumulator(onUpdate)
    }
  }, [])

  useEffect(() => { statusRef.current = status }, [status])
  useEffect(() => { trackedAnchorRef.current = trackedAnchor }, [trackedAnchor])
  useEffect(() => { vimModeRef.current = vimMode }, [vimMode])
  useEffect(() => { conflictFilesRef.current = conflictFiles }, [conflictFiles])
  useEffect(() => {
    sourceFilesRef.current = null
    sourceFilesPromiseRef.current = null
  }, [doc?.docName])

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
    const res = await fetch(projectApiPath(doc.docName, '/source-cursor'), {
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
      if (!canShowSourceCursorLaser(trackedAnchorRef.current)) {
        cursorLaserSeqRef.current += 1
        clearCursorLaser()
        return
      }
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
        const res = await fetch(projectApiPath(doc!.docName, ''))
        if (!res.ok) throw new Error(`project ${res.status}`)
        const info = await res.json()
        projectInfoRef.current = info
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
        const res = await fetch(projectApiPath(doc!.docName, ''))
        if (!res.ok) throw new Error(`project ${res.status}`)
        const info = await res.json()
        projectInfoRef.current = info
        if (cancelled) return
        const files = info?.overleafSyncStatus === 'conflict' && Array.isArray(info?.overleafConflictFiles)
          ? info.overleafConflictFiles.map(normalizeFile)
          : []
        setServerConflictFiles(files)
      } catch {
        if (!cancelled) setServerConflictFiles([])
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
      const next = sourceAnchorForViewport(mainEditor, lookup) || htmlSourceAnchorForViewport(mainEditor)
      if (!next) return
      setSourceSplit(next.source === 'synctex' && next.anchored ? sourceSplitForAnchor(lookup, next) : null)
      setTrackedAnchor(prev => {
        const nextLine = next.anchored ? next.line : null
        const resolved = { file: next.file, line: nextLine, source: next.source, anchored: next.anchored }
        if (shouldReuseTrackedSourceAnchor(prev, resolved, SOURCE_TRACK_LINE_THRESHOLD)) return prev
        return { ...resolved, page: next.page }
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
      if (secondaryWriteTimerRef.current) window.clearTimeout(secondaryWriteTimerRef.current)
    }
  }, [])

  const loadSourceFiles = async () => {
    if (!doc?.docName) return []
    if (sourceFilesRef.current) return sourceFilesRef.current
    if (!sourceFilesPromiseRef.current) {
      sourceFilesPromiseRef.current = fetch(projectApiPath(doc.docName, '/files'))
        .then(async (res) => {
          if (!res.ok) throw new Error(`files ${res.status}`)
          const payload = await res.json()
          const files = Array.isArray(payload?.files) ? payload.files.map(normalizeFile) : []
          sourceFilesRef.current = files
          return files
        })
        .catch(() => {
          sourceFilesRef.current = []
          return []
        })
    }
    return sourceFilesPromiseRef.current
  }

  const resolveSourceFilePath = async (sourceFile: string) => {
    const normalized = normalizeFile(sourceFile)
    const files = await loadSourceFiles()
    if (files.includes(normalized)) return normalized
    const base = basename(normalized)
    const matches = files.filter(candidate => basename(candidate) === base)
    return matches.length === 1 ? matches[0] : normalized
  }

  const writeSourceFile = async (sourceFile: string, nextFullText: string) => {
    if (!doc?.docName || !sourceFile) return null
    const sourcePath = await resolveSourceFilePath(sourceFile)
    if (!projectInfoRef.current) {
      const infoRes = await fetch(projectApiPath(doc.docName, ''))
      if (infoRes.ok) projectInfoRef.current = await infoRes.json()
    }
    const sourceManifest = normalizeSourceManifest([...await loadSourceFiles(), sourcePath], projectInfoRef.current || {})
    const authorityRes = await fetch(projectApiPath(doc.docName, '/source-authority'))
    if (!authorityRes.ok) throw new Error(`source authority ${authorityRes.status}`)
    const sourceAuthority = await authorityRes.json()
    const res = await fetch(projectApiPath(doc.docName, `/source/${encodeURIComponent(sourcePath)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: nextFullText,
        sourceManifest,
        editedBy: shape.props.userId || shape.props.deviceId || 'fleet-source-editor',
        expectedRevision: sourceAuthority.currentRevision,
      }),
    })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok || payload?.ok === false) {
      // A stale-base rejection already carries a real three-way merge for every
      // file — the server ran `git merge-file -p`. Hand this file's conflicted
      // text back so the editor can put the markers in front of the person
      // instead of showing them "Sync failed".
      const merged = conflictedTextFor(payload, sourcePath)
      if (merged !== null) {
        const conflict = new Error('Conflict — resolve the markers, then it syncs') as Error & { conflictText?: string }
        conflict.conflictText = merged
        throw conflict
      }
      throw new Error(payload?.error || `sync ${res.status}`)
    }
    return payload
  }

  const trackedAnchorStatusText = (sourceWindow: { targetLine: number }) => {
    const anchor = trackedAnchorRef.current
    if (!anchor.anchored || anchor.line == null) return 'Unanchored'
    const pageText = anchor.page ? ` p${anchor.page}` : ''
    return `${lineStatusText(file, sourceWindow)}${pageText}`
  }

  const writeSource = async (nextFullText: string, seq: number) => {
    if (!doc?.docName || !file) return
    if (nextFullText === savedTextRef.current) {
      setStatus('ready')
      setStatusText(trackedAnchorStatusText(sourceWindowRef.current))
      return
    }
    setStatus('syncing')
    setStatusText('Syncing...')
    try {
      const payload = await writeSourceFile(file, nextFullText)
      if (seq !== saveSeqRef.current) return
      // The write landed, so whatever this editor was holding is resolved.
      setHeldConflictFile((held) => (held === normalizeFile(file) ? null : held))
      conflictRawTextRef.current = ''
      savedTextRef.current = nextFullText
      fullSourceRef.current = nextFullText
      setSourceHasConflictMarkers(hasConflictMarkers(nextFullText))
      sourceWindowRef.current = sourceWindowForText(nextFullText, sourceWindowRef.current.targetLine)
      setStatus('synced')
      setStatusText(payload?.building ? 'Synced; build queued' : 'Synced')
    } catch (err: any) {
      if (seq !== saveSeqRef.current) return
      // A conflict is not an error to report — it is work to do. Put the merged
      // text with its git markers into the buffer; that lights the resolve UI
      // that already exists, and the write stays held until it is resolved.
      if (typeof err?.conflictText === 'string') {
        loadConflictIntoEditor(err.conflictText)
        setStatus('dirty')
        setStatusText('Conflict — resolve the markers, then it syncs')
        return
      }
      setStatus('error')
      setStatusText(err?.message || 'Sync failed')
    }
  }

  // Replace the buffer with the server's three-way merge. Not an edit of the
  // person's text: their side is inside the markers, and resolving is how they
  // get it back. `conflictFiles` is what stops the next write from firing.
  const loadConflictIntoEditor = (conflictText: string) => {
    fullSourceRef.current = conflictText
    conflictRawTextRef.current = conflictText
    setSourceHasConflictMarkers(true)
    setHeldConflictFile(normalizeFile(file))
    const view = cmViewRef.current
    if (!view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: conflictText } })
  }

  // Writes are checkpoints, not a stream. Typing arms the idle boundary; the
  // click-out and leave-insert-mode boundaries flush it immediately.
  const queueWrite = (text: string) => {
    saveSeqRef.current += 1
    const seq = saveSeqRef.current
    if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
    setStatus('dirty')
    setStatusText('Sync pending...')
    writeTimerRef.current = window.setTimeout(() => {
      writeTimerRef.current = null
      void writeSource(text, seq)
    }, idleWriteMs())
  }
  queueWriteRef.current = queueWrite

  // A boundary was reached — commit now instead of waiting out the idle timer.
  const flushWrite = () => {
    if (!writeTimerRef.current) return
    window.clearTimeout(writeTimerRef.current)
    writeTimerRef.current = null
    const text = fullSourceRef.current
    if (text === undefined) return
    saveSeqRef.current += 1
    void writeSource(text, saveSeqRef.current)
  }
  flushWriteRef.current = flushWrite

  const queueSecondaryWrite = (sourceFile: string, text: string) => {
    secondarySaveSeqRef.current += 1
    const seq = secondarySaveSeqRef.current
    if (secondaryWriteTimerRef.current) window.clearTimeout(secondaryWriteTimerRef.current)
    secondaryWriteTimerRef.current = window.setTimeout(() => {
      secondaryWriteTimerRef.current = null
      void writeSourceFile(sourceFile, text)
        .then(() => {
          if (seq !== secondarySaveSeqRef.current) return
          secondarySavedTextRef.current = text
          secondaryFullSourceRef.current = text
        })
        .catch((err: any) => {
          if (seq !== secondarySaveSeqRef.current) return
          setStatus('error')
          setStatusText(`${sourceFile}: ${err?.message || 'Sync failed'}`)
        })
    }, idleWriteMs())
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
        const sourcePath = await resolveSourceFilePath(file)
        const res = await fetch(projectApiPath(doc!.docName, `/source/${encodeURIComponent(sourcePath)}`))
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
	              if (update.selectionSet) {
	                updateCursorLaserFromView(update.view)
	                if (!voiceApplyingRef.current && voiceSessionRef.current?.view === update.view) {
	                  voiceSessionRef.current = {
	                    view: update.view,
	                    from: update.view.state.selection.main.head,
	                    to: update.view.state.selection.main.head,
	                  }
	                  notifyAccumulatorCursorMoved()
	                }
	              }
	              if (!update.docChanged) return
	              const currentText = update.state.doc.toString()
	              fullSourceRef.current = currentText
              setSourceHasConflictMarkers(hasConflictMarkers(currentText))
	              if (currentText === savedTextRef.current) {
	                if (writeTimerRef.current) window.clearTimeout(writeTimerRef.current)
	                writeTimerRef.current = null
	                setStatus('ready')
	                setStatusText(trackedAnchorStatusText(sourceWindowRef.current))
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
        const handleVoiceFocus = () => activateVoiceEditor(view)
        view.dom.addEventListener('focusin', handleVoiceFocus)
        // Write boundary: clicking out commits. `focusout` fires for moves
        // within the editor too, so only commit once focus has actually left.
        const handleWriteOnBlur = (event: FocusEvent) => {
          const next = event.relatedTarget as Node | null
          if (next && view.dom.contains(next)) return
          flushWriteRef.current?.()
        }
        view.dom.addEventListener('focusout', handleWriteOnBlur)
	        cmKeydownCleanupRef.current = () => {
	          view.dom.removeEventListener('keydown', handleNativeKeydown, { capture: true })
	          view.dom.removeEventListener('focusin', handleVoiceFocus)
	          view.dom.removeEventListener('focusout', handleWriteOnBlur)
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
          CM5.on(cm, 'vim-mode-change', (e: any) => {
            const nextMode = e.mode || 'normal'
            // Write boundary: leaving insert mode commits.
            if (vimModeRef.current === 'insert' && nextMode !== 'insert') flushWriteRef.current?.()
            setVimModeState(nextMode)
          })
          Vim.defineEx('write', 'w', () => {
            const current = cmViewRef.current?.state.doc.toString()
            if (current !== undefined) queueWriteRef.current?.(current)
          })
        }
	        setStatus('ready')
	        setStatusText(trackedAnchorStatusText(sourceWindow))
	        if (!canShowSourceCursorLaser(trackedAnchor)) {
	          clearCursorLaser()
	          return
	        }
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
    setStatusText(trackedAnchorStatusText(sourceWindow))
    if (!canShowSourceCursorLaser(trackedAnchor)) {
      clearCursorLaser()
      return
    }
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
	  }, [file, shape.props.line, trackedAnchor.line, trackedAnchor.page, trackedAnchor.anchored, trackedAnchor.source])

  useEffect(() => {
    const nextFile = normalizeFile(trackedAnchor.file)
    if (nextFile && nextFile !== file && statusRef.current !== 'dirty' && statusRef.current !== 'syncing') {
      setFile(nextFile)
    }
  }, [file, trackedAnchor.file])

  const handlePointerDown = (e: any) => {
    stopEventPropagation(e)
    const target = e.target as Node
    if (!cmHostRef.current?.contains(target) && !secondaryCmHostRef.current?.contains(target)) return
    requestAnimationFrame(() => {
      if (secondaryCmHostRef.current?.contains(target)) activateVoiceEditor(secondaryCmViewRef.current)
      else activateVoiceEditor(cmViewRef.current)
    })
  }
  const handleKeyDown = (e: any) => {
    const target = e.target as Node
    if (!cmHostRef.current?.contains(target) && !secondaryCmHostRef.current?.contains(target)) return
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
    setTrackedAnchor({ file: entry.file, line: entry.line, page: entry.page, source: 'synctex', anchored: true })
  }
  const currentFileConflicted = conflictFiles.includes(normalizeFile(file))
  const canResolveConflict = currentFileConflicted && !sourceHasConflictMarkers && status !== 'syncing'
  const secondaryFile = sourceSplit
    ? normalizeFile(file) === normalizeFile(sourceSplit.beforeFile)
      ? normalizeFile(sourceSplit.afterFile)
      : normalizeFile(file) === normalizeFile(sourceSplit.afterFile)
        ? normalizeFile(sourceSplit.beforeFile)
        : null
    : null
  const primaryOnTop = !sourceSplit || normalizeFile(file) === normalizeFile(sourceSplit.beforeFile)

  useEffect(() => {
    if (!doc?.docName || !secondaryFile || !secondaryCmHostRef.current) {
      secondaryCmViewRef.current?.destroy()
      secondaryCmViewRef.current = null
      secondarySavedTextRef.current = ''
      secondaryFullSourceRef.current = ''
      return
    }

    const docName = doc.docName
    const activeSecondaryFile = secondaryFile
    const activeSplit = sourceSplit
    let cancelled = false
    let keydownCleanup: (() => void) | null = null
    let panelCleanup: (() => void) | null = null

    async function loadSecondarySource() {
      if (secondaryWriteTimerRef.current) window.clearTimeout(secondaryWriteTimerRef.current)
      secondaryWriteTimerRef.current = null
      try {
        const sourcePath = await resolveSourceFilePath(activeSecondaryFile)
        const res = await fetch(projectApiPath(docName, `/source/${encodeURIComponent(sourcePath)}`))
        if (!res.ok) throw new Error(`source ${res.status}`)
        const text = await res.text()
        if (cancelled || !secondaryCmHostRef.current) return

        keydownCleanup?.()
        panelCleanup?.()
        secondaryCmViewRef.current?.destroy()
        secondarySavedTextRef.current = text
        secondaryFullSourceRef.current = text
        const startState = EditorState.create({
          doc: text,
          extensions: [
            sourceEditorHistoryKeymap,
            ...(useVim ? [vim()] : []),
            lineNumbers(),
            history({ minDepth: 10000 }),
            latex(),
            EditorView.lineWrapping,
            sourceEditorTheme,
            EditorView.updateListener.of((update) => {
              if (update.selectionSet && !voiceApplyingRef.current && voiceSessionRef.current?.view === update.view) {
                voiceSessionRef.current = {
                  view: update.view,
                  from: update.view.state.selection.main.head,
                  to: update.view.state.selection.main.head,
                }
                notifyAccumulatorCursorMoved()
              }
              if (!update.docChanged) return
              const currentText = update.state.doc.toString()
              secondaryFullSourceRef.current = currentText
              if (currentText === secondarySavedTextRef.current) {
                if (secondaryWriteTimerRef.current) window.clearTimeout(secondaryWriteTimerRef.current)
                secondaryWriteTimerRef.current = null
                return
              }
              queueSecondaryWrite(activeSecondaryFile, currentText)
            }),
            keymap.of([...defaultKeymap, ...historyKeymap]),
          ],
        })
        const view = new EditorView({ state: startState, parent: secondaryCmHostRef.current })
        const handleNativeKeydown = (event: KeyboardEvent) => {
          const key = String(event.key || '').toLowerCase()
          const mod = event.metaKey || event.ctrlKey
          if (!mod || event.altKey || (key !== 'z' && key !== 'y')) return
          event.preventDefault()
          event.stopPropagation()
          if (useVim) {
            const cm = getCM(view)
            if (!cm) return
            Vim.handleKey(cm, '<Esc>', 'user')
            Vim.handleKey(cm, key === 'y' || event.shiftKey ? '<C-r>' : 'u', 'user')
            return
          }
          if (key === 'y' || event.shiftKey) redo(view)
          else undo(view)
        }
        view.dom.addEventListener('keydown', handleNativeKeydown, { capture: true })
        const handleVoiceFocus = () => activateVoiceEditor(view)
        view.dom.addEventListener('focusin', handleVoiceFocus)
        keydownCleanup = () => view.dom.removeEventListener('keydown', handleNativeKeydown, { capture: true })
        const previousKeydownCleanup = keydownCleanup
        keydownCleanup = () => {
          previousKeydownCleanup?.()
          view.dom.removeEventListener('focusin', handleVoiceFocus)
        }
        stripVimRegexHints(view.dom)
        const panelObserver = new MutationObserver(() => stripVimRegexHints(view.dom))
        panelObserver.observe(view.dom, { childList: true, subtree: true, characterData: true })
        panelCleanup = () => panelObserver.disconnect()
        const cm = useVim ? getCM(view) : null
        if (cm) cm.setOption('pcre', true)
        secondaryCmViewRef.current = view
        const targetLine = Math.max(1, Math.min(
          activeSplit && normalizeFile(activeSecondaryFile) === normalizeFile(activeSplit.beforeFile)
            ? activeSplit.beforeLine
            : activeSplit?.afterLine || 1,
          view.state.doc.lines,
        ))
        const line = view.state.doc.line(targetLine)
        view.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
        })
      } catch (err: unknown) {
        if (cancelled) return
        secondaryCmViewRef.current?.destroy()
        secondaryCmViewRef.current = null
        setStatus('error')
        const message = err instanceof Error ? err.message : 'Failed to load source'
        setStatusText(`${activeSecondaryFile}: ${message}`)
      }
    }

    void loadSecondarySource()
    return () => {
      cancelled = true
      keydownCleanup?.()
      panelCleanup?.()
      secondaryCmViewRef.current?.destroy()
      secondaryCmViewRef.current = null
    }
  }, [doc?.docName, secondaryFile, sourceSplit?.beforeFile, sourceSplit?.beforeLine, sourceSplit?.afterFile, sourceSplit?.afterLine, useVim])

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
      <FleetPanelButtonGroup editor={editor} shape={shape} />
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
        <div className={`fleet-source-editor-split${secondaryFile && sourceSplit ? ' fleet-source-editor-split-active' : ''}`}>
          <div
            ref={cmHostRef}
            className="fleet-source-editor-cm fleet-source-editor-pane"
            style={{ order: primaryOnTop ? 0 : 2 }}
          />
          {secondaryFile && sourceSplit && (
            <>
              <div className="fleet-source-editor-seam" aria-hidden="true" style={{ order: 1 }}>
                <span>{basename(sourceSplit.beforeFile)}</span>
                <div />
                <span>{basename(sourceSplit.afterFile)}</span>
              </div>
              <div
                ref={secondaryCmHostRef}
                className="fleet-source-editor-cm fleet-source-editor-pane"
                style={{ order: primaryOnTop ? 2 : 0 }}
              />
            </>
          )}
        </div>
	      </div>
    </div>
  )
}
