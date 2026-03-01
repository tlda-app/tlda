import { useMemo, useEffect, useRef, useState, useCallback, useContext, useSyncExternalStore } from 'react'
import {
  Tldraw,
  react,
  useEditor,
  DefaultColorStyle,
  DefaultSizeStyle,
  defaultShapeUtils,
  defaultBindingUtils,
  HighlightShapeUtil,
} from 'tldraw'
import type { TLComponents, Editor, TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { MathNoteShapeUtil, setMathNoteEntryMode, setReplyContext } from './MathNoteShape'
import { switchTab, addTab } from './noteThreading'
import { HtmlPageShapeUtil } from './HtmlPageShape'
import { SvgPageShapeUtil } from './SvgPageShape'
import { SvgFigureShapeUtil } from './SvgFigureShape'
import { getSvgViewBox, setNavigateToAnchor, setOnSourceClick, anchorIndex, hasSvgText, setChangeHighlights, dismissAllChanges, changedPages, type ChangeRegion } from './stores'
import { BrowseTool } from './BrowseTool'
import { MathNoteTool } from './MathNoteTool'
import { TextSelectTool } from './TextSelectTool'
import { initSignalConnection, teardownSignalConnection, isSignalConnected, dispatchSignalDirect, writeSignal, broadcastCamera, broadcastPresenter, onPresenterSignal, onBuildStatusSignal, type BuildError, type BuildWarning } from './useYjsSync'
import { useSync, type RemoteTLStoreWithStatus } from '@tldraw/sync'
import { appendToken } from './authToken'
import { DocumentPanel, AgentPill } from './DocumentPanel'
import { AgentAttentionOverlay } from './AgentAttentionOverlay'
import { PenHelperButtons, DarkModeSync } from './toolbar/ToolbarComponents'
import { FormatToolbar } from './toolbar/FormatToolbar'
import { DocContext, PanelContext, BottomPanelsContext, AgentPillContext } from './PanelContext'
import { NoteDropHandler } from './NoteDropHandler'
import { setCurrentDocumentInfo, pageSpacing, type SvgDocument, type LabelRegion } from './svgDocumentLoader'
import { ProofStatementOverlay } from './ProofStatementOverlay'
import { ScrollyOverlay } from './ScrollyOverlay'
import { RefViewer } from './RefViewer'
import { BuildErrorOverlay } from './BuildErrorOverlay'
import { BuildWarningPill } from './BuildWarningPill'
import { AnnotationVisibilityPill } from './AnnotationVisibilityPill'
import { DraftPill } from './DraftPill'
import { FollowingBadge } from './FollowingBadge'
import { initRole, getRole, toggleRole, subscribeRole } from './viewerRole'
import { ChangePreviewPanel } from './ChangePreviewPanel'
import { useHistoryOverlay } from './hooks/useHistoryOverlay'
import { initSnapshots } from './snapshotStore'
import { PDF_HEIGHT, PAGE_HEIGHT, PAGE_GAP } from './layoutConstants'
import { setupPulseForDiffLayout } from './diffHelpers'
import { buildReverseIndex } from './synctexLookup'
import { openInEditor } from './texsync'
import { setupSvgEditor, fetchSvgPagesAsync, anchorIdToLabel, type ReloadResult } from './editorSetup'
import { getFormatConfig, homeTool as getHomeTool } from './formatConfig'
import { useSnapshotTimeline } from './hooks/useSnapshotTimeline'
import { useCameraLink } from './hooks/useCameraLink'
import { useDiffToggle } from './hooks/useDiffToggle'
import { useProofToggle } from './hooks/useProofToggle'
import { useRefViewer } from './hooks/useRefViewer'
import { useYjsSignals } from './hooks/useYjsSignals'

// Sync server URL - use env var, or derive from window.location
// Dev mode (Vite on 5173): connect to sync server on 5176
// Production (unified server): same host, ws/wss based on protocol
const SYNC_SERVER = import.meta.env.VITE_SYNC_SERVER ||
  (import.meta.env.DEV
    ? `ws://${window.location.hostname}:5176`
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`)

const LICENSE_KEY = 'tldraw-2027-01-19/WyJhUGMwcWRBayIsWyIqLnF0bTI4NS5naXRodWIuaW8iXSw5LCIyMDI3LTAxLTE5Il0.Hq9z1V8oTLsZKgpB0pI3o/RXCoLOsh5Go7Co53YGqHNmtEO9Lv/iuyBPzwQwlxQoREjwkkFbpflOOPmQMwvQSQ'

// Agent attention overlay wrapper (needs useEditor context)
function AgentAttentionCanvas() {
  const editor = useEditor()
  return <AgentAttentionOverlay editor={editor} />
}

// Slots rendered inside InFrontOfTheCanvas — read content from context
// so the memoized components callback doesn't need to close over changing state
function BottomPanelsSlot() {
  const content = useContext(BottomPanelsContext)
  return <>{content}</>
}

function AgentPillSlot() {
  const content = useContext(AgentPillContext)
  return <>{content}</>
}

// Sync server URL for @tldraw/sync shape CRDT (WebSocket)
const SHAPE_SYNC_SERVER = import.meta.env.VITE_SYNC_SERVER ||
  (import.meta.env.DEV
    ? `ws://${window.location.hostname}:5176`
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`)

// Initialize signal connection when the document mounts (signals go via HTTP POST + @tldraw/sync custom messages)
function useSignalInit(docName: string) {
  useEffect(() => {
    initSignalConnection(docName, SYNC_SERVER)
    return () => teardownSignalConnection()
  }, [docName])
}

// Inline base64 asset store (for image uploads via AssetToolbarItem)
const INLINE_ASSETS = {
  upload: async (_asset: any, file: File) => {
    const reader = new FileReader()
    const src = await new Promise<string>((resolve) => {
      reader.onload = () => resolve(reader.result as string)
      reader.readAsDataURL(file)
    })
    return { src }
  },
  resolve: (asset: any) => asset.props.src,
}

interface SvgDocumentEditorProps {
  document: SvgDocument
  roomId: string
  diffConfig?: { basePath: string }
}


export function SvgDocumentEditor({ document, roomId, diffConfig }: SvgDocumentEditorProps) {
  // Initialize signal connection (signals via HTTP POST + @tldraw/sync custom messages)
  useSignalInit(document.name)

  const editorRef = useRef<Editor | null>(null)
  const sessionRestoredRef = useRef(false)

  // --- Cross-cutting refs shared by hooks ---
  const shapeIdSetRef = useRef<Set<TLShapeId>>(new Set())
  const shapeIdsArrayRef = useRef<TLShapeId[]>([])
  const updateCameraBoundsRef = useRef<((bounds: any) => void) | null>(null)
  const ensurePagesAtBottomRef = useRef<(() => void) | null>(null)
  const focusChangeRef = useRef<((currentPage: number) => void) | null>(null)

  // --- Panels local toggle (hide RefViewer + ProofStatementOverlay locally) ---
  const [panelsLocal, setPanelsLocal] = useState(true)
  const panelsLocalRef = useRef(true)
  const [editorMounted, setEditorMounted] = useState(false)
  useEffect(() => { panelsLocalRef.current = panelsLocal }, [panelsLocal])
  const togglePanelsLocal = useCallback(() => { setPanelsLocal(prev => !prev) }, [])

  // --- Hooks ---
  const docName = new URLSearchParams(window.location.search).get('doc') || document.name
  const { historyEntries, activeHistoryIdx, historyLoading, historyChangedPages, historyChanges, handleHistoryChange, refreshHistory } = useSnapshotTimeline(document, docName)
  const { overlayActive: showHistoryPanel, toggleOverlay: toggleHistoryOverlay, hideOverlay: hideHistoryOverlay } = useHistoryOverlay(
    editorRef, document, shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef,
  )
  // Hide overlay when slider returns to current
  const isAtEnd = activeHistoryIdx < 0 || activeHistoryIdx >= historyEntries.length - 1
  useEffect(() => {
    if (isAtEnd && showHistoryPanel) hideHistoryOverlay()
  }, [isAtEnd])

  // Selected change tracking — highlights selected change differently
  const [selectedChangeId, setSelectedChangeId] = useState<string | null>(null)
  const handleSelectChange = useCallback((id: string | null) => {
    setSelectedChangeId(id)

    // Auto-activate overlay if selecting a change and overlay isn't active
    if (id && !showHistoryPanel && activeHistoryIdx >= 0 && activeHistoryIdx < historyEntries.length) {
      toggleHistoryOverlay(docName, historyEntries[activeHistoryIdx].id, historyChangedPages)
    }

    // Re-apply highlights with selection coloring
    if (!historyChangedPages || historyChangedPages.length === 0) return
    const SELECTED_NEW = '#1d4ed8'  // blue for selected (new side)
    const DEFAULT_NEW = '#1d4ed8'   // blue when nothing selected (new side)
    const SELECTED_OLD = '#dc2626'  // red for selected (old side)
    const DEFAULT_OLD = '#dc2626'   // red when nothing selected (old side)
    dismissAllChanges()
    for (const pd of historyChangedPages) {
      const pageData = document.pages[pd.page - 1]
      if (!pageData?.shapeId) continue
      if (!pd.changes || pd.changes.length === 0) continue

      // New (current) side
      const newRegions: Array<{ y: number; height: number; x?: number; width?: number; tint?: string }> = []
      // Old side
      const oldRegions: Array<{ y: number; height: number; x?: number; width?: number; tint?: string }> = []

      for (const c of pd.changes) {
        const newTint = id === null ? DEFAULT_NEW : c.id === id ? SELECTED_NEW : undefined
        const oldTint = id === null ? DEFAULT_OLD : c.id === id ? SELECTED_OLD : undefined
        if (c.newLines && c.newLines.length > 0) {
          for (const l of c.newLines) {
            newRegions.push({ y: l.y, height: l.height, x: l.x, width: l.width, tint: newTint })
          }
        } else if (c.y != null && c.height != null) {
          newRegions.push({ y: c.y, height: c.height, x: c.x, width: c.width, tint: newTint })
        }
        if (c.oldLines && c.oldLines.length > 0) {
          for (const l of c.oldLines) {
            oldRegions.push({ y: l.y, height: l.height, x: l.x, width: l.width, tint: oldTint })
          }
        }
      }
      if (newRegions.length > 0) setChangeHighlights(pageData.shapeId, newRegions)

      // Old page shape (only exists when overlay is active)
      const oldShapeId = `shape:${docName}-hist-old-${pd.page}`
      if (oldRegions.length > 0) setChangeHighlights(oldShapeId, oldRegions)
    }
  }, [historyChangedPages, document, showHistoryPanel, activeHistoryIdx, historyEntries, toggleHistoryOverlay, docName])
  // Legacy aliases for backward compatibility with panel context
  const snapshotCount = historyEntries.length
  const snapshotSliderIdx = activeHistoryIdx
  const handleSliderChange = handleHistoryChange

  const { suppressBroadcastRef, broadcastTimerRef } = useCameraLink(editorRef)

  // Initialize role from localStorage
  const docNameForRole = new URLSearchParams(window.location.search).get('doc') || document.name
  useMemo(() => initRole(docNameForRole), [docNameForRole])
  const role = useSyncExternalStore(subscribeRole, getRole)

  // Broadcast presenter identity when role changes
  useEffect(() => {
    broadcastPresenter(role === 'presenter')
  }, [role])

  const {
    diffMode, diffLoading, toggleDiff,
    diffDataRef, diffModeRef, toggleDiffRef,
    hasDiffToggle, hasDiffBuiltin, setDiffFetchSeq,
  } = useDiffToggle({
    editorRef, document, diffConfig,
    shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef, focusChangeRef,
  })

  const {
    proofMode, proofLoading, toggleProof,
    proofDataRef, proofModeRef, toggleProofRef,
    proofDataReady, setProofDataReady, setProofFetchSeq,
  } = useProofToggle({
    editorRef, document,
    shapeIdSetRef, shapeIdsArrayRef,
  })

  const {
    refViewerRefs, setRefViewerRefs, setRefViewerRefsLocal,
    refViewerLineRef,
    navigateRef, handleGoThere, handleGoBack, canGoBack,
    clearHistory,
  } = useRefViewer({
    editorRef, document, proofDataRef, proofDataReady,
  })

  // --- Reload error state (page fetch failures → stale pill) ---
  const [reloadErrors, setReloadErrors] = useState<ReloadResult | null>(null)
  // Remap warnings from reload (merged into buildWarnings below)
  const [remapWarnings, setRemapWarnings] = useState<BuildWarning[]>([])

  useYjsSignals({
    editorRef, document,
    diffDataRef, setDiffFetchSeq,
    proofDataRef, setProofDataReady, setProofFetchSeq,
    setRefViewerRefs, refViewerLineRef, panelsLocalRef,
    onReloadResult: useCallback((result: ReloadResult | null) => {
      if (!result) {
        setReloadErrors(null)
        setRemapWarnings([])
        return
      }
      setReloadErrors(result.failedPages.length > 0 ? result : null)
      if (result.remapResult && result.remapResult.failed > 0) {
        const { failed, total } = result.remapResult
        setRemapWarnings([{
          message: `${failed}/${total} annotations couldn't remap after rebuild`,
          category: 'remap' as const,
        }])
      } else {
        setRemapWarnings([])
      }
    }, []),
  })

  // --- Build error state ---
  const [buildErrors, setBuildErrors] = useState<BuildError[]>([])
  const [texWarnings, setTexWarnings] = useState<BuildWarning[]>([])

  useEffect(() => {
    return onBuildStatusSignal((signal) => {
      const errors = signal.errors || []
      setBuildErrors(errors)
      setTexWarnings((signal.warnings || []).map(w => ({ ...w, category: 'tex' as const })))
      // When errors clear, immediately clean up error shapes on the canvas
      // (belt-and-suspenders — BuildErrorOverlay also cleans up on unmount)
      if (errors.length === 0 && editorRef.current) {
        const editor = editorRef.current
        const toDelete = editor.getCurrentPageShapes()
          .filter(s => s.id.startsWith('shape:build-error-') || (s.type === 'text' && s.isLocked && s.x >= 800))
          .map(s => s.id)
        if (toDelete.length > 0) editor.store.remove(toDelete)
      }
    })
  }, [])

  const buildWarnings = useMemo(() => [...texWarnings, ...remapWarnings], [texWarnings, remapWarnings])

  // Guard: skip keyboard shortcuts when a DOM input/textarea has focus
  function isInputFocused() {
    const tag = window.document.activeElement?.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || (window.document.activeElement as HTMLElement)?.isContentEditable
  }

  // Keyboard shortcut: 'i' or ':' to enter math note in vim mode
  // Track last-edited note so 'i' with nothing selected re-enters it
  const lastEditedNoteRef = useRef<string | null>(null)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'i' && e.key !== ':') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isInputFocused()) return
      const editor = editorRef.current
      if (!editor) return
      if (editor.getEditingShapeId()) return
      const selected = editor.getSelectedShapeIds()
      let targetId: string | null = null
      if (selected.length === 1) {
        const shape = editor.getShape(selected[0])
        if (shape && (shape.type as string) === 'math-note') {
          targetId = shape.id
        }
      } else if (selected.length === 0 && lastEditedNoteRef.current) {
        // Nothing selected — try re-entering last edited note
        const shape = editor.getShape(lastEditedNoteRef.current as any)
        if (shape && (shape.type as string) === 'math-note') {
          targetId = shape.id
          editor.select(shape.id)
        } else {
          lastEditedNoteRef.current = null
        }
      }
      if (!targetId) return
      e.preventDefault()

      // 'i' on a tabbed note: create reply tab with split-view context
      if (e.key === 'i') {
        const targetShape = editor.getShape(targetId as any)
        const targetTabs = targetShape && (targetShape.props as any).tabs as string[] | undefined
        if (targetTabs && targetTabs.length >= 1) {
          // Save current tab text as reply context
          const currentText = (targetShape!.props as any).text || ''
          setReplyContext(currentText)
          addTab(editor, targetId as any, '')
        }
      }

      setMathNoteEntryMode(e.key as 'i' | ':')
      editor.setEditingShape(targetId as any)
      lastEditedNoteRef.current = targetId
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Arrow keys cycle tabs on selected math-note (vim-style navigation)
  useEffect(() => {
    const handleArrowKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'h' && e.key !== 'l') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isInputFocused()) return
      const editor = editorRef.current
      if (!editor) return
      if (editor.getEditingShapeId()) return
      const selected = editor.getSelectedShapeIds()
      if (selected.length !== 1) return
      const shape = editor.getShape(selected[0])
      if (!shape || (shape.type as string) !== 'math-note') return
      const tabs = (shape.props as any).tabs as string[] | undefined
      if (!tabs || tabs.length <= 1) return
      const active = (shape.props as any).activeTab || 0
      const next = (e.key === 'ArrowRight' || e.key === 'l')
        ? Math.min(active + 1, tabs.length - 1)
        : Math.max(active - 1, 0)
      if (next !== active) {
        e.preventDefault()
        switchTab(editor, shape.id, next)
      }
    }
    window.addEventListener('keydown', handleArrowKey)
    return () => window.removeEventListener('keydown', handleArrowKey)
  }, [])

  // Track last-edited note across all entry methods (double-click, etc.)
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    return editor.store.listen(() => {
      const editingId = editor.getEditingShapeId()
      if (editingId) {
        const shape = editor.getShape(editingId)
        if (shape && (shape.type as string) === 'math-note') {
          lastEditedNoteRef.current = editingId
        }
      }
    }, { scope: 'session' })
  }, [])

  // n/p keyboard shortcuts for diff change navigation (global, not tied to ChangesTab)
  useEffect(() => {
    const changes = hasDiffBuiltin
      ? document.diffLayout?.changes
      : (diffMode ? diffDataRef.current?.changes : undefined)
    if (!changes || changes.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isInputFocused()) return
      const editor = editorRef.current
      if (!editor) return
      if (editor.getEditingShapeId()) return
      if (e.key !== 'n' && e.key !== 'p') return

      e.preventDefault()
      const cam = editor.getCamera()
      const vb = editor.getViewportScreenBounds()
      const centerY = -cam.y + (vb.y + vb.h / 2) / cam.z
      let closest = 0
      let closestDist = Infinity
      for (let i = 0; i < document.pages.length; i++) {
        const p = document.pages[i]
        const pageCenterY = p.bounds.y + p.bounds.h / 2
        const dist = Math.abs(centerY - pageCenterY)
        if (dist < closestDist) {
          closestDist = dist
          closest = i + 1
        }
      }
      const currentPage = closest
      const changePages = changes.map(c => c.currentPage)

      let target: number | undefined
      if (e.key === 'n') {
        target = changePages.find(p => p > currentPage) ?? changePages[0]
      } else {
        target = [...changePages].reverse().find(p => p < currentPage) ?? changePages[changePages.length - 1]
      }
      if (target) {
        const pageIndex = target - 1
        if (pageIndex >= 0 && pageIndex < document.pages.length) {
          const page = document.pages[pageIndex]
          editor.centerOnPoint(
            { x: page.bounds.x + page.bounds.w / 2, y: page.bounds.y },
            { animation: { duration: 300 } }
          )
        }
        focusChangeRef.current?.(target)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [document, hasDiffBuiltin, diffMode])

  // n/p keyboard shortcuts for multipage HTML: switch TLDraw pages
  useEffect(() => {
    if (document.format !== 'html') return
    // Don't conflict with diff n/p handler
    const hasDiffChanges = hasDiffBuiltin
      ? (document.diffLayout?.changes?.length ?? 0) > 0
      : diffMode && (diffDataRef.current?.changes?.length ?? 0) > 0
    if (hasDiffChanges) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isInputFocused()) return
      if (e.key !== 'n' && e.key !== 'p') return
      const editor = editorRef.current
      if (!editor) return
      if (editor.getEditingShapeId()) return

      e.preventDefault()
      const pages = editor.getPages()
      if (pages.length <= 1) return
      const currentIdx = pages.findIndex(p => p.id === editor.getCurrentPageId())
      if (currentIdx < 0) return

      if (e.key === 'n' && currentIdx < pages.length - 1) {
        editor.setCurrentPage(pages[currentIdx + 1].id)
      } else if (e.key === 'p' && currentIdx > 0) {
        editor.setCurrentPage(pages[currentIdx - 1].id)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [document, hasDiffBuiltin, diffMode])

  const components = useMemo<TLComponents>(
    () => ({
      PageMenu: null,
      SharePanel: null,
      MainMenu: null,
      Toolbar: () => <FormatToolbar format={document.format} />,
      HelperButtons: () => <PenHelperButtons format={document.format} />,
      InFrontOfTheCanvas: () => <><DocumentPanel /><AgentAttentionCanvas /><BottomPanelsSlot /><AgentPillSlot /></>,
    }),
    [document, roomId]
  )

  const docKey = new URLSearchParams(window.location.search).get('doc') || document.name

  // Pulse effect for standalone diff docs
  useEffect(() => {
    if (!document.diffLayout) return
    const diff = document.diffLayout
    setupPulseForDiffLayout(editorRef, document.name, diff, focusChangeRef)
  }, [document])

  // Stable doc info — only changes when a different document loads
  const docContextValue = useMemo(() => ({
    docName: docKey,
    format: document.format,
    pages: document.pages.map(p => ({
      bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
      width: p.width,
      height: p.height,
      textData: p.textData,
      shapeId: p.shapeId,
      tldrawPageId: p.tldrawPageId,
    })),
  }), [docKey, document])

  // Volatile panel state — toggles, loading flags, history, etc.
  const panelContextValue = useMemo(() => ({
    diffChanges: hasDiffBuiltin ? document.diffLayout?.changes : (diffMode ? diffDataRef.current?.changes : undefined),
    onFocusChange: (page: number) => focusChangeRef.current?.(page),
    diffAvailable: hasDiffToggle,
    diffMode,
    onToggleDiff: hasDiffToggle ? toggleDiff : undefined,
    diffLoading,
    proofPairs: proofDataReady ? proofDataRef.current?.pairs : undefined,
    proofMode,
    onToggleProof: toggleProof,
    proofLoading,
    role,
    onToggleRole: toggleRole,
    panelsLocal,
    onTogglePanelsLocal: togglePanelsLocal,
    snapshotCount,
    snapshotTimestamps: historyEntries.length > 0 ? historyEntries.map(e => e.timestamp) : undefined,
    activeSnapshotIdx: snapshotSliderIdx,
    onSliderChange: handleSliderChange,
    historyEntries,
    activeHistoryIdx,
    historyLoading,
    historyChangedPages,
    historyChanges,
    onHistoryChange: handleHistoryChange,
    showHistoryPanel,
    onToggleHistoryPanel: () => {
      if (activeHistoryIdx >= 0 && activeHistoryIdx < historyEntries.length) {
        toggleHistoryOverlay(docKey, historyEntries[activeHistoryIdx].id, historyChangedPages)
      }
    },
    selectedChangeId,
    onSelectChange: handleSelectChange,
    buildErrors,
    buildWarnings,
  }), [docKey, hasDiffBuiltin, hasDiffToggle, diffMode, diffLoading, toggleDiff, proofMode, proofLoading, proofDataReady, toggleProof, role, panelsLocal, togglePanelsLocal, snapshotCount, snapshotSliderIdx, handleSliderChange, historyEntries, activeHistoryIdx, historyLoading, historyChangedPages, historyChanges, handleHistoryChange, showHistoryPanel, toggleHistoryOverlay, selectedChangeId, handleSelectChange, buildErrors, buildWarnings])

  const shapeUtils = useMemo(() => {
    // Suppress the default hover/selection indicator on highlight shapes —
    // it draws a blue path outline that competes with our text glow effect
    class QuietHighlightShapeUtil extends HighlightShapeUtil {
      override indicator() { return null }
    }
    const utils = defaultShapeUtils.map(u => u === HighlightShapeUtil ? QuietHighlightShapeUtil : u)
    return [...utils, MathNoteShapeUtil, HtmlPageShapeUtil, SvgPageShapeUtil, SvgFigureShapeUtil]
  }, [])
  const bindingUtils = useMemo(() => [...defaultBindingUtils], [])
  const tools = useMemo(() => [BrowseTool, MathNoteTool, TextSelectTool], [])

  // --- @tldraw/sync: shape CRDT sync ---
  const syncUri = useMemo(
    () => () => appendToken(`${SHAPE_SYNC_SERVER}/sync/${roomId}`),
    [roomId]
  )
  const onCustomMessage = useCallback((data: any) => {
    // Signals from server's broadcastSignal (e.g., POST /signal endpoint)
    if (data?.key) dispatchSignalDirect(data.key, data)
  }, [])
  const storeWithStatus = useSync({
    uri: syncUri,
    shapeUtils,
    bindingUtils,
    assets: INLINE_ASSETS,
    onCustomMessageReceived: onCustomMessage,
  })

  // Override toolbar to replace note with math-note
  const overrides = useMemo(() => ({
    tools: (_editor: Editor, tools: any) => {
      // Add math-note tool definition
      tools['math-note'] = {
        id: 'math-note',
        icon: 'tool-note',
        label: 'Math Note',
        kbd: 'm',
        onSelect: () => _editor.setCurrentTool('math-note'),
      }
      // Override the 'note' tool to activate math-note instead
      if (tools['note']) {
        tools['note'] = {
          ...tools['note'],
          onSelect: () => _editor.setCurrentTool('math-note'),
        }
      }
      // Register text-select tool (kbd 't') with I-beam icon
      tools['text-select'] = {
        id: 'text-select',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M7 3h4M7 15h4M9 3v12" />
        </svg>) as any,
        label: 'Select Text',
        kbd: 't',
        onSelect: () => _editor.setCurrentTool('text-select'),
      }
      // Register browse tool — pointer with starburst sparkle (interactive pages)
      tools['browse'] = {
        id: 'browse',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {/* Smaller pointer arrow, shifted down-left */}
          <path d="M2 4.5l1 11 2.8-3.5 4.2 1.8L2 4.5z" fill="currentColor" stroke="none" />
          <path d="M2 4.5l1 11 2.8-3.5 4.2 1.8L2 4.5z" fill="none" />
          {/* Starburst sparkle — 8 spikes, prominent */}
          {(() => {
            const cx = 12.5, cy = 5.5, rOuter = 5, rInner = 1.8, spikes = 8
            const pts = []
            for (let i = 0; i < spikes * 2; i++) {
              const angle = (i * Math.PI) / spikes - Math.PI / 2
              const r = i % 2 === 0 ? rOuter : rInner
              pts.push(`${+(cx + Math.cos(angle) * r).toFixed(1)},${+(cy + Math.sin(angle) * r).toFixed(1)}`)
            }
            return <polygon points={pts.join(' ')} fill="currentColor" stroke="none" />
          })()}
        </svg>) as any,
        label: 'Browse',
        onSelect: () => _editor.setCurrentTool('browse'),
      }
      return tools
    },
  }), [])

  // Bottom panels content — passed via context into InFrontOfTheCanvas
  const bottomPanelsContent = (
    <div className="bottom-panels">
      {panelsLocal && refViewerRefs && editorRef.current && (
        <RefViewer
          mainEditor={editorRef.current}
          pages={docContextValue.pages}
          refs={refViewerRefs}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={LICENSE_KEY}
          onClose={() => {
            setRefViewerRefsLocal(null)
            clearHistory()
          }}
          onPrevLine={() => navigateRef(-1)}
          onNextLine={() => navigateRef(1)}
          onGoThere={handleGoThere}
          onGoBack={handleGoBack}
          canGoBack={canGoBack}
        />
      )}
      {panelsLocal && proofDataReady && editorRef.current && proofDataRef.current && (
        <ProofStatementOverlay
          mainEditor={editorRef.current}
          proofData={proofDataRef.current}
          pages={docContextValue.pages}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={LICENSE_KEY}
        />
      )}
      {panelsLocal && getFormatConfig(document.format).showScrollyOverlay && editorMounted && editorRef.current && (
        <ScrollyOverlay mainEditor={editorRef.current} />
      )}
      {selectedChangeId && editorRef.current && (
        <ChangePreviewPanel
          mainEditor={editorRef.current}
          selectedChangeId={selectedChangeId}
          historyChanges={historyChanges}
          docName={docName}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={LICENSE_KEY}
          onSelectChange={handleSelectChange}
        />
      )}
      <div className="build-pills-row">
        {role === 'presenter' ? <AnnotationVisibilityPill /> : <><DraftPill /><FollowingBadge /></>}
        <BuildWarningPill warnings={buildWarnings} />
        {editorRef.current && (
          <BuildErrorOverlay
            mainEditor={editorRef.current}
            errors={buildErrors}
            reloadErrors={reloadErrors}
            doc={docContextValue}
            shapeUtils={shapeUtils}
            tools={tools}
            licenseKey={LICENSE_KEY}
          />
        )}
      </div>
    </div>
  )

  const agentPillContent = editorRef.current ? <AgentPill editor={editorRef.current} /> : null

  return (
    <DocContext.Provider value={docContextValue}>
    <PanelContext.Provider value={panelContextValue}>
    <BottomPanelsContext.Provider value={bottomPanelsContent}>
    <AgentPillContext.Provider value={agentPillContent}>
    <Tldraw
        store={storeWithStatus}
        licenseKey={LICENSE_KEY}
        shapeUtils={shapeUtils}
        tools={tools}
        overrides={overrides}
        onMount={(editor) => {
          // Expose editor for debugging/puppeteer access
          (window as unknown as { __tldraw_editor__: Editor }).__tldraw_editor__ = editor
          editorRef.current = editor
          setEditorMounted(true)

          // Set up hyperref link navigation: open target in RefViewer panel
          setNavigateToAnchor((anchorId: string, title: string) => {
            const entry = anchorIndex.get(anchorId)
            if (!entry) return

            // Find which page this anchor is on
            const pageIdx = document.pages.findIndex(p => p.shapeId === entry.pageShapeId)
            if (pageIdx < 0) return

            // Convert xlink:title (e.g. "equation.28") to display label
            const { type, displayLabel } = anchorIdToLabel(title || anchorId)

            // Convert viewBox to PDF coordinates
            let yTop = 0, yBottom = PDF_HEIGHT
            const svgVB = getSvgViewBox(entry.pageShapeId)
            if (svgVB && entry.viewBox) {
              const parts = entry.viewBox.split(/\s+/).map(Number)
              if (parts.length === 4) {
                const [, svgY, , svgH] = parts
                yTop = (svgY - svgVB.minY) / svgVB.height * PDF_HEIGHT
                yBottom = yTop + svgH / svgVB.height * PDF_HEIGHT
              }
            }

            const region: LabelRegion = { page: pageIdx + 1, yTop, yBottom, type, displayLabel }
            setRefViewerRefsLocal([{ label: anchorId, region }])
          })

          const editorSetup = setupSvgEditor(editor, document)
          shapeIdSetRef.current = editorSetup.shapeIdSet
          shapeIdsArrayRef.current = editorSetup.shapeIds
          updateCameraBoundsRef.current = editorSetup.updateBounds
          ensurePagesAtBottomRef.current = editorSetup.ensurePagesAtBottom

          // With @tldraw/sync, the store already has synced shapes when onMount fires.
          // Ensure page backgrounds are at the bottom of the z-order.
          editorSetup.ensurePagesAtBottom()

          // Clean up stale build-error shapes that may have persisted in the sync store
          {
            const toDelete = editor.getCurrentPageShapes()
              .filter(s => s.id.startsWith('shape:build-error-') || (s.type === 'text' && s.isLocked && s.x >= 800))
              .map(s => s.id)
            if (toDelete.length > 0) editor.store.remove(toDelete)
          }

          // Signal that pages are ready (still used by some listeners)
          window.dispatchEvent(new CustomEvent('tldraw-pages-ready'))

          // For SVG documents: fetch page content in background (layout is already displayed)
          if (!document.format || document.format === 'svg') {
            const hasContent = document.pages.some(p => hasSvgText(p.shapeId))
            if (!hasContent) {
              fetchSvgPagesAsync(editor, document)
            }
          }

          // Follow system dark/light mode preference
          editor.user.updateUserPreferences({ colorScheme: 'system' })

          // Default drawing style: purple, 70% opacity, small size
          editor.setStyleForNextShapes(DefaultColorStyle, 'violet')
          editor.setStyleForNextShapes(DefaultSizeStyle, 's')
          editor.setOpacityForNextShapes(0.7)

          // Set global document info for synctex anchoring
          setCurrentDocumentInfo({
            name: document.name,
            pages: document.pages.map(p => ({
              bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
              width: p.width,
              height: p.height
            }))
          })

          // Cmd-click → open source in editor via texsync:// URL scheme
          {
            // Build page index: shapeId → pageIndex (1-based)
            const shapeToPage = new Map<string, number>()
            for (let i = 0; i < document.pages.length; i++) {
              shapeToPage.set(document.pages[i].shapeId, i + 1)
            }

            buildReverseIndex(document.name).then((reverseLookup) => {
              if (!reverseLookup) return

              setOnSourceClick((shapeId: string, clickYFraction: number) => {
                const page = shapeToPage.get(shapeId)
                if (!page) return

                // Convert click fraction to PDF y coordinate
                const pdfY = clickYFraction * PDF_HEIGHT
                const match = reverseLookup(page, pdfY)
                if (!match) return

                openInEditor(document.name, match.file, match.line)
              })
            })
          }

          // Remapping is triggered by YjsSyncProvider after initial sync

          // Initialize snapshot store for change tracking across refreshes
          initSnapshots(document.name)

          // --- Session persistence ---
          const sessionKey = `tldraw-session:${roomId}`

          function saveSession() {
            try {
              const cam = editor.getCamera()
              const tool = editor.getCurrentToolId()
              localStorage.setItem(sessionKey, JSON.stringify({
                camera: { x: cam.x, y: cam.y, z: cam.z },
                pageId: editor.getCurrentPageId(),
                tool,
                diffMode: diffModeRef.current,
                proofMode: proofModeRef.current,
                panelsLocal: panelsLocalRef.current,
              }))
            } catch { /* quota exceeded etc */ }
          }

          function loadSession() {
            try {
              const raw = localStorage.getItem(sessionKey)
              if (!raw) return null
              return JSON.parse(raw) as { camera?: { x: number; y: number; z: number }; pageId?: string; tool?: string; diffMode?: boolean; proofMode?: boolean; panelsLocal?: boolean }
            } catch { return null }
          }

          // Restore session after constraints and Yjs sync settle,
          // then start watching for changes.
          // Guard: onMount fires multiple times (React Strict Mode double-invokes
          // TLDraw's layout effect on every commit). Only restore+watch once.
          if (!sessionRestoredRef.current) {
            sessionRestoredRef.current = true
            const session = loadSession()
            setTimeout(() => {
              if (session?.pageId) {
                // Restore TLDraw page (multipage HTML) before restoring camera
                const pages = editor.getPages()
                if (pages.some(p => p.id === session.pageId)) {
                  editor.setCurrentPage(session.pageId as any)
                }
              }
              if (session?.camera) {
                editor.setCamera(session.camera)
              }
              if (session?.tool) {
                try { editor.setCurrentTool(session.tool) } catch { /* tool may not exist */ }
              } else {
                const home = getHomeTool(getFormatConfig(document.format))
                if (home !== 'select') {
                  editor.setCurrentTool(home)
                }
              }
              // Restore diff mode if it was active
              if (session?.diffMode && hasDiffToggle) {
                toggleDiffRef.current()
              }
              if (session?.proofMode) {
                toggleProofRef.current()
              }
              // Role is restored from localStorage by initRole() — no session override needed
              if (session?.panelsLocal === false) {
                setPanelsLocal(false)
              }

              // Start save watchers only after restore
              let cameraTimer: ReturnType<typeof setTimeout> | null = null
              react('save-camera', () => {
                editor.getCamera() // subscribe
                if (cameraTimer) clearTimeout(cameraTimer)
                cameraTimer = setTimeout(() => {
                  saveSession()
                  // Report visible pages for watcher priority rebuild
                  if (isSignalConnected() && document.pages.length > 0) {
                    const vb = editor.getViewportScreenBounds()
                    const cam = editor.getCamera()
                    // Convert screen bounds to canvas coords
                    const top = -cam.y + vb.y / cam.z
                    const bottom = top + vb.h / cam.z
                    const pageH = document.pages[0].height + pageSpacing
                    const firstPage = Math.max(1, Math.floor(top / pageH) + 1)
                    const lastPage = Math.min(document.pages.length, Math.floor(bottom / pageH) + 1)
                    const pages: number[] = []
                    for (let p = firstPage; p <= lastPage; p++) pages.push(p)
                    writeSignal('signal:viewport', { pages })
                  }
                }, 500)
              })

              // Save session on page switch (multipage HTML)
              react('save-page', () => {
                editor.getCurrentPageId() // subscribe
                saveSession()
              })

              // Camera broadcast: presenter sends position to viewers
              react('broadcast-camera', () => {
                const cam = editor.getCamera() // subscribe
                if (getRole() !== 'presenter' || suppressBroadcastRef.current) return
                if (broadcastTimerRef.current) clearTimeout(broadcastTimerRef.current)
                broadcastTimerRef.current = setTimeout(() => {
                  if (getRole() === 'presenter' && !suppressBroadcastRef.current) {
                    broadcastCamera(cam.x, cam.y, cam.z)
                  }
                }, 30)
              })

              react('save-tool', () => {
                editor.getCurrentToolId() // subscribe
                saveSession()
              })

              // Browse bounce-back: when the select tool deselects everything
              // in an interactive doc, return to browse mode. The browse tool delegates
              // to select for note interaction; this closes the loop.
              if (getFormatConfig(document.format).browseBounce) {
                let bounceTimer: ReturnType<typeof setTimeout> | null = null
                react('browse-bounce', () => {
                  const tool = editor.getCurrentToolId()
                  const sel = editor.getSelectedShapeIds()
                  if (bounceTimer) { clearTimeout(bounceTimer); bounceTimer = null }
                  if (tool === 'select' && sel.length === 0) {
                    // Small delay: don't bounce during transient states (mid-click)
                    bounceTimer = setTimeout(() => {
                      if (editor.getCurrentToolId() === 'select' &&
                          editor.getSelectedShapeIds().length === 0) {
                        editor.setCurrentTool('browse')
                      }
                    }, 300)
                  }
                })
              }
            }, 500)
          }

          // Keyboard shortcuts
          const handleKeyDown = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return
            if (isInputFocused()) return
            if (editor.getEditingShapeId()) return

            if (e.key === 'm') {
              editor.setCurrentTool('math-note')
            }
          }
          window.addEventListener('keydown', handleKeyDown)

          // Dismiss reload-sourced change highlights on canvas click
          const container = editor.getContainer()
          container.addEventListener('pointerdown', () => {
            if (changedPages.size > 0) dismissAllChanges()
          })

          // Axis-lock two-finger scroll: snap to vertical or horizontal
          // when the gesture is approximately aligned (3:1 ratio).
          // Intercept at editor.dispatch since @use-gesture binds wheel internally.
          const origDispatch = editor.dispatch.bind(editor)
          const AXIS_RATIO = 2
          editor.dispatch = (info: any) => {
            if ((info.type === 'wheel' || info.type === 'pinch') && info.delta) {
              const ax = Math.abs(info.delta.x)
              const ay = Math.abs(info.delta.y)
              if (ay > ax * AXIS_RATIO && ax > 0.3) {
                info = { ...info, delta: { ...info.delta, x: 0 } }
              } else if (ax > ay * AXIS_RATIO && ay > 0.3) {
                info = { ...info, delta: { ...info.delta, y: 0 } }
              }
            }
            return origDispatch(info)
          }
        }}
        components={components}
        forceMobile
    >
      <DarkModeSync />
      <NoteDropHandler />
    </Tldraw>
    </AgentPillContext.Provider>
    </BottomPanelsContext.Provider>
    </PanelContext.Provider>
    </DocContext.Provider>
  )
}
