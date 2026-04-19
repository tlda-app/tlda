import { useMemo, useEffect, useRef, useState, useCallback, useContext, createContext, useSyncExternalStore, Component } from 'react'
import type { ReactNode, ErrorInfo } from 'react'
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
import { MathNoteShapeUtil, setMathNoteEntryMode } from './shapes/MathNoteShape'
import { TocDropTargetShapeUtil, TocDropTargetManager } from './shapes/TocDropTargetShape'
// noteThreading removed — no tabs
import { HtmlPageShapeUtil } from './shapes/HtmlPageShape'
import { SvgPageShapeUtil } from './shapes/SvgPageShape'
import { SvgFigureShapeUtil } from './shapes/SvgFigureShape'
import { ReadingAssistBarShapeUtil } from './shapes/ReadingAssistBarShape'
import { UnderstandingLineShapeUtil } from './shapes/UnderstandingLineShape'
import { TimelineOverlayShapeUtil } from './shapes/TimelineOverlayShape'
import { ZoomableImageShapeUtil } from './shapes/ZoomableImageShape'
// DotAnnotationShape removed — math-note dots replace it
import { FleetChatShapeUtil } from './shapes/FleetChatShape'
import { FleetAgentsShapeUtil } from './shapes/FleetAgentsShape'
import { FleetDocViewShapeUtil } from './shapes/FleetDocViewShape'
import { FleetPillShapeUtil } from './shapes/FleetPillShape'
import { FleetSearchShapeUtil } from './shapes/FleetSearchShape'
import { ClusterShapeUtil } from './shapes/ClusterShape'
import { TerminalShapeUtil } from './shapes/TerminalShape'
import { InlineDocShapeUtil } from './shapes/InlineDocShape'
import { DocVersionShapeUtil } from './shapes/DocVersionShape'
import { PlaybackFrameShapeUtil } from './shapes/PlaybackFrameShape'
import { HighlighterSlider } from './shapes/HighlighterSliderShape'
import { ToolNameHud } from './overlays/ToolNameHud'
import { getSvgViewBox, setNavigateToAnchor, setOnSourceClick, anchorIndex, hasSvgText, setChangeHighlights, dismissAllChanges, changedPages } from './stores'
import { BrowseTool } from './tools/BrowseTool/BrowseTool'
import { PhoneHandTool } from './tools/PhoneHandTool'
import { MathNoteTool } from './tools/MathNoteTool'
import { VoiceNoteTool } from './tools/VoiceNoteTool'
import { TextSelectTool } from './tools/TextSelectTool'
import { FleetChatTool } from './tools/FleetChatTool'
import { FleetAgentsTool } from './tools/FleetAgentsTool'
import { FleetSearchTool } from './tools/FleetSearchTool'
import { ClusterTool } from './tools/ClusterTool'
import { TerminalTool } from './tools/TerminalTool'
import { PlaybackTool } from './tools/PlaybackTool'
import { TaskInboxShapeUtil } from './shapes/TaskInboxShape'
import { TaskInboxTool } from './tools/TaskInboxTool'
import { initSignalConnection, teardownSignalConnection, isSignalConnected, dispatchSignalDirect, writeSignal, broadcastCamera, broadcastPresenter, onBuildStatusSignal, onViewPinSignal, onCompareSignal, type BuildError, type BuildWarning } from './useYjsSync'
import { useSync } from '@tldraw/sync'
import { appendToken } from './authToken'
import { DocumentPanel, PhoneOverlay, AgentPill, HighlighterButton, SemanticHighlightPill, VoiceNoteButton } from './DocumentPanel'
import { AgentAttentionOverlay } from './overlays/AgentAttentionOverlay'
import { RecognizeButton } from './overlays/RecognizeButton'
import { PenHelperButtons, DarkModeSync } from './toolbar/ToolbarComponents'
import { FormatToolbar } from './toolbar/FormatToolbar'
import { DocContext, PanelContext, BottomPanelsContext, AgentPillContext } from './PanelContext'
import { NoteDropHandler } from './NoteDropHandler'
import { MarkdownDropHandler } from './MarkdownDropHandler'
import { setCurrentDocumentInfo, pageSpacing, type SvgDocument, type LabelRegion } from './svgDocumentLoader'
import { ScrollyOverlay } from './overlays/ScrollyOverlay'
import { RefViewer } from './overlays/RefViewer'
import { ScreenshotCapture } from './overlays/ScreenshotCapture'
import { FleetHUD, fleetHudOpenRef } from './overlays/FleetHUD'

const FLEET_TYPES_FOR_VIS = new Set(['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview'])
import { BuildWarningPill } from './pills/BuildWarningPill'
import { AnnotationVisibilityPill } from './pills/AnnotationVisibilityPill'
import { DraftPill } from './pills/DraftPill'
import { FollowingBadge } from './pills/FollowingBadge'
import { initRole, getRole, toggleRole, subscribeRole } from './viewerRole'
import { setDraftMode } from './annotationVisibility'
import { ChangePreviewPanel } from './overlays/ChangePreviewPanel'
import { AnnotationViewer } from './overlays/AnnotationViewer'
import { useHistoryOverlay } from './hooks/useHistoryOverlay'
import { initSnapshots } from './snapshotStore'
import { PDF_HEIGHT } from './layoutConstants'
import { setupPulseForDiffLayout } from './diffHelpers'
import { buildReverseIndex } from './synctexLookup'
import { openInEditor } from './texsync'
import { setupSvgEditor, fetchSvgPagesAsync, anchorIdToLabel, type ReloadResult } from './editorSetup'
import { getFormatConfig, homeTool as getHomeTool } from './formatConfig'
import { useSnapshotTimeline } from './hooks/useSnapshotTimeline'
import { useCameraLink } from './hooks/useCameraLink'
import { getCameraLinked } from './cameraLink'
import { useDiffToggle } from './hooks/useDiffToggle'
import { useProofToggle } from './hooks/useProofToggle'
import { useRefViewer } from './hooks/useRefViewer'
import { useYjsSignals } from './hooks/useYjsSignals'
import { useSyncedPlayback } from './hooks/useSyncedPlayback'
import { useFleetTheme } from './hooks/useFleetTheme'
import { useTimelineOverlay } from './hooks/useTimelineOverlay'
import { useDocAutoOpen } from './hooks/useDocAutoOpen'
import { useFootControl } from './hooks/useFootControl'
import { FootControlDebug } from './footControlDebug'
import { subscribeInputModes, getFootEnabled, getClicksEnabled, getWhistleEnabled, getHissEnabled } from './inputModes'
import { useShadowOverlay } from './hooks/useShadowOverlay'
import { useCompareColumn } from './hooks/useCompareColumn'
import { ShadowHistoryOverlay } from './overlays/ShadowHistoryOverlay'
import { PlaybackPill } from './pills/PlaybackPill'
import { SlidesNavigator } from './SlidesNavigator'

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

const VersionStampContext = createContext<React.ReactNode>(null)
function VersionStampSlot() {
  const content = useContext(VersionStampContext)
  return <>{content}</>
}


// Error boundary for individual shape renders — catches throws in a shape's component()
// and shows a small error placeholder instead of crashing the entire app.
class ShapeErrorBoundary extends Component<
  { shapeType: string; children: ReactNode },
  { hasError: boolean; errorMsg: string }
> {
  constructor(props: { shapeType: string; children: ReactNode }) {
    super(props)
    this.state = { hasError: false, errorMsg: '' }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMsg: error.message }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Shape render error [${this.props.shapeType}]:`, error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          width: '100%', height: '100%', minWidth: 40, minHeight: 24,
          background: 'rgba(220, 38, 38, 0.15)', border: '1px solid rgba(220, 38, 38, 0.4)',
          borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, color: '#dc2626', fontFamily: 'monospace', padding: '2px 6px',
          pointerEvents: 'all',
        }}>
          {this.props.shapeType}: error
        </div>
      )
    }
    return this.props.children
  }
}

// Wrap a ShapeUtil class so its component() renders inside a ShapeErrorBoundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withShapeErrorBoundary<T extends new (...args: any[]) => any>(Util: T): T {
  const originalComponent = Util.prototype.component
  if (!originalComponent) return Util

  // Create a subclass that overrides component() with an error-boundary wrapper
  const Wrapped = class extends (Util as any) {
    component(shape: any) {
      const inner = originalComponent.call(this, shape)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const typeName = (this.constructor as any).type || 'unknown'
      return <ShapeErrorBoundary shapeType={typeName}>{inner}</ShapeErrorBoundary>
    }
  } as unknown as T

  // Preserve static fields (type, props, migrations, etc.)
  Object.defineProperty(Wrapped, 'type', { value: (Util as any).type, configurable: true })
  Object.defineProperty(Wrapped, 'props', { value: (Util as any).props, configurable: true })
  if ((Util as any).migrations) {
    Object.defineProperty(Wrapped, 'migrations', { value: (Util as any).migrations, configurable: true })
  }

  return Wrapped
}

// Sync server URL for @tldraw/sync shape CRDT (WebSocket) — same as SYNC_SERVER
const SHAPE_SYNC_SERVER = SYNC_SERVER

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
  initialCamera?: { x: number; y: number; z: number; page?: string }
}


/**
 * ViewPinBadge — shown when the viewer is displaying a pinned old version via doc_view.
 * Disappears automatically when the daemon pushes fresh source files.
 * Click to unpin (trigger a rebuild from current source).
 */
function ViewPinBadge({ docName }: { docName: string }) {
  const [pinnedRef, setPinnedRef] = useState<string | null>(null)

  useEffect(() => {
    return onViewPinSignal((sig) => {
      setPinnedRef(sig.ref ?? null)
    })
  }, [])

  if (!pinnedRef) return null

  return (
    <span
      className="view-pin-badge"
      title="Viewing pinned version — click to return to HEAD"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={async () => {
        try {
          await fetch(`/api/projects/${docName}/build`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        } catch {}
        setPinnedRef(null)
      }}
    >
      📌 {pinnedRef} ✕
    </span>
  )
}

/**
 * VersionStamp — shows a small stack of recent build timestamps with
 * perspective-style opacity. The current (latest) version is most visible;
 * older versions fade out. Click an older version → doc_view to that hash.
 * Updates after each build.
 */
const MAX_VISIBLE_VERSIONS = 5

function VersionStamp({ docName }: { docName: string }) {
  const [versions, setVersions] = useState<Array<{ hash: string; timestamp: string | number }>>([])
  const [activeIdx, setActiveIdx] = useState(0)

  const fetchVersions = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${docName}/history/shadow`)
      if (!res.ok) return
      const raw = await res.json()
      const data: Array<{ hash: string; timestamp: number }> = raw.versions || raw
      if (!data || data.length === 0) return
      setVersions(data.slice(0, MAX_VISIBLE_VERSIONS))
      setActiveIdx(0)
    } catch {}
  }, [docName])

  useEffect(() => { fetchVersions() }, [fetchVersions])
  useEffect(() => {
    return onBuildStatusSignal(() => { setTimeout(fetchVersions, 1000) })
  }, [fetchVersions])

  const handleClick = useCallback(async (idx: number) => {
    if (idx === 0) {
      if (activeIdx !== 0) {
        try { await fetch(`/api/projects/${docName}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }) } catch {}
        setActiveIdx(0)
      }
      return
    }
    const v = versions[idx]
    if (!v) return
    try {
      await fetch(`/api/projects/${docName}/history/shadow/${v.hash}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      setActiveIdx(idx)
    } catch {}
  }, [docName, versions, activeIdx])

  if (versions.length === 0) return null

  return (
    <div
      className="version-stamp"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* Current version at top, older versions fading downward. */}
      {versions.map((v, i) => {
        const hash7 = v.hash.slice(0, 7)
        const time = new Date(v.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        const isActive = i === activeIdx
        const baseOpacity = isActive ? 0.7 : Math.max(0.08, 0.35 - i * 0.07)
        return (
          <div
            key={v.hash}
            className={`version-stamp-entry${isActive ? ' active' : ''}`}
            style={{ opacity: baseOpacity }}
            onClick={() => handleClick(i)}
            title={`${hash7} — ${new Date(v.timestamp).toLocaleString()}`}
          >
            {time}{i === 0 && <span className="version-stamp-hash"> · {hash7}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** Slide navigation wrapper — uses SlidesNavigator for spatial canvas navigation */
function SlideNavWrapper({ document }: { document: SvgDocument }) {
  const editor = useEditor()
  return <SlidesNavigator editor={editor} document={document} />
}

export function SvgDocumentEditor({ document, roomId, diffConfig, initialCamera }: SvgDocumentEditorProps) {
  // Initialize signal connection (signals via HTTP POST + @tldraw/sync custom messages)
  useSignalInit(document.name)

  const editorRef = useRef<Editor | null>(null)
  const restoredEditorRef = useRef<Editor | null>(null)

  // --- Cross-cutting refs shared by hooks ---
  const shapeIdSetRef = useRef<Set<TLShapeId>>(new Set())
  const shapeIdsArrayRef = useRef<TLShapeId[]>([])
  const updateCameraBoundsRef = useRef<((bounds: any) => void) | null>(null)
  const ensurePagesAtBottomRef = useRef<(() => void) | null>(null)
  const focusChangeRef = useRef<((currentPage: number) => void) | null>(null)

  // --- Screenshot capture state ---
  const [screenshotCapture, setScreenshotCapture] = useState<import('./hooks/useYjsSignals').ScreenshotCaptureState | null>(null)

  // --- Panels local toggle (hide RefViewer + ProofStatementOverlay locally) ---
  const [panelsLocal, setPanelsLocal] = useState(true)
  const panelsLocalRef = useRef(true)
  const [editorMounted, setEditorMounted] = useState(0)
  useEffect(() => { panelsLocalRef.current = panelsLocal }, [panelsLocal])
  const togglePanelsLocal = useCallback(() => { setPanelsLocal(prev => !prev) }, [])

  // --- Hooks ---
  const docName = new URLSearchParams(window.location.search).get('doc') || document.name
  const { historyEntries, activeHistoryIdx, historyLoading, historyChangedPages, historyChanges, handleHistoryChange } = useSnapshotTimeline(document, docName)
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

  const isPresentation = document.format === 'slides'
  const { suppressBroadcastRef, broadcastTimerRef } = useCameraLink(editorRef, isPresentation)

  // Role only meaningful in presentation (slides) format
  const docNameForRole = new URLSearchParams(window.location.search).get('doc') || document.name
  useMemo(() => {
    if (isPresentation) { initRole(docNameForRole); setDraftMode(getRole() === 'viewer') }
  }, [docNameForRole, isPresentation])
  const role = useSyncExternalStore(subscribeRole, getRole)

  // Presentation: broadcast presenter identity + sync draft mode to role
  useEffect(() => {
    if (!isPresentation) return
    if (role === 'presenter') broadcastPresenter(true)
    setDraftMode(role === 'viewer')
  }, [role, isPresentation])

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

  // Remap warnings from reload (merged into buildWarnings below)
  const [remapWarnings, setRemapWarnings] = useState<BuildWarning[]>([])

  // Fleet playback — listen for BroadcastChannel and swap annotation shapes
  const playbackState = useSyncedPlayback(editorRef, docName)

  // Spatial timeline overlay — activity scatter plot
  const { timelineActive, toggleTimeline } = useTimelineOverlay(editorRef, document, docName)

  // Shadow history scrubber
  const {
    shadowVersions, shadowActiveIdx, shadowLoading, shadowVisible,
    toggleShadowOverlay, hideShadowOverlay, handleShadowScrub,
  } = useShadowOverlay(editorRef, document, docName, shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef)

  // Side-by-side version comparison — relay Yjs signal to window event
  useEffect(() => {
    const unsub = onCompareSignal((data) => {
      window.dispatchEvent(new CustomEvent('tlda-compare', { detail: data }))
    })
    return unsub
  }, [])
  useCompareColumn(editorRef.current, docName, document?.pages?.length ?? 0)

  // Sync theme from fleet dashboard (cross-origin SSE)
  useFleetTheme()

  // Auto-open shared docs pushed via fleet
  useDocAutoOpen(editorRef, document, docName)

  // Input mode toggles (localStorage-persisted, per-feature on/off)
  const footEnabled = useSyncExternalStore(subscribeInputModes, getFootEnabled)
  const clicksEnabled = useSyncExternalStore(subscribeInputModes, getClicksEnabled)
  const whistleEnabled = useSyncExternalStore(subscribeInputModes, getWhistleEnabled)
  const hissEnabled = useSyncExternalStore(subscribeInputModes, getHissEnabled)

  // Foot pedal control (rudder + toe brakes → cursor/pan, tongue click/lip pop → click/enter)
  const { footInstance, clickInstance } = useFootControl(editorMounted ? editorRef.current : null, {
    enabled: footEnabled || clicksEnabled,
    clicksEnabled,
    whistleEnabled,
    hissEnabled,
  })

  useYjsSignals({
    editorRef, document,
    diffDataRef, setDiffFetchSeq,
    proofDataRef, setProofDataReady, setProofFetchSeq,
    setRefViewerRefs, refViewerLineRef, panelsLocalRef,
    setScreenshotCapture,
    onReloadResult: useCallback((result: ReloadResult | null) => {
      if (!result) {
        setRemapWarnings([])
        return
      }
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

      setMathNoteEntryMode(e.key as 'i' | ':')
      editor.setEditingShape(targetId as any)
      lastEditedNoteRef.current = targetId
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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
      InFrontOfTheCanvas: () => <><DocumentPanel /><PhoneOverlay /><HighlighterButton /><VoiceNoteButton /><SemanticHighlightPill /><AgentAttentionCanvas /><RecognizeButton /><BottomPanelsSlot /><AgentPillSlot /><HighlighterSlider /><ToolNameHud /><VersionStampSlot /></>,
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
    timelineActive,
    onToggleTimeline: toggleTimeline,
    shadowHistoryVisible: shadowVisible,
    onToggleShadowHistory: toggleShadowOverlay,
    shadowHistoryVersionCount: shadowVersions.length,
    shadowVersions,
    shadowActiveIdx,
  }), [docKey, hasDiffBuiltin, hasDiffToggle, diffMode, diffLoading, toggleDiff, proofMode, proofLoading, proofDataReady, toggleProof, role, panelsLocal, togglePanelsLocal, snapshotCount, snapshotSliderIdx, handleSliderChange, historyEntries, activeHistoryIdx, historyLoading, historyChangedPages, historyChanges, handleHistoryChange, showHistoryPanel, toggleHistoryOverlay, selectedChangeId, handleSelectChange, buildErrors, buildWarnings, timelineActive, toggleTimeline, shadowVisible, toggleShadowOverlay, shadowVersions])
  // Note: shadowActiveIdx intentionally excluded from deps — changes to it
  // should NOT cascade re-renders through PanelContext (causes hooks errors)

  // When the fleet HUD overlay is open, hide fleet shapes in the main editor
  // from both rendering AND hit-testing. The overlay renders its own copies.
  // Uses a stable ref (fleetHudOpenRef) so the callback identity never changes
  // (changing it would recreate the entire editor).
  const getShapeVisibility = useCallback((shape: any) => {
    if (fleetHudOpenRef.current && FLEET_TYPES_FOR_VIS.has(shape.type)) return 'hidden' as const
    return undefined
  }, [])

  const shapeUtils = useMemo(() => {
    // Suppress the default hover/selection indicator on highlight shapes —
    // it draws a blue path outline that competes with our text glow effect
    class QuietHighlightShapeUtil extends HighlightShapeUtil {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      override indicator() { return null as any }
    }
    const utils = defaultShapeUtils.map(u => u === HighlightShapeUtil ? QuietHighlightShapeUtil : u)
    // Wrap every custom shape util with an error boundary so a single broken shape
    // renders an error placeholder instead of crashing the entire app.
    const customUtils = [MathNoteShapeUtil, HtmlPageShapeUtil, SvgPageShapeUtil, SvgFigureShapeUtil, TocDropTargetShapeUtil, ReadingAssistBarShapeUtil, UnderstandingLineShapeUtil, TimelineOverlayShapeUtil, ZoomableImageShapeUtil, FleetChatShapeUtil, FleetAgentsShapeUtil, FleetPillShapeUtil, FleetSearchShapeUtil, FleetDocViewShapeUtil, InlineDocShapeUtil, DocVersionShapeUtil, ClusterShapeUtil, TerminalShapeUtil, TaskInboxShapeUtil, PlaybackFrameShapeUtil]
    const all = [...utils, ...customUtils.map(u => withShapeErrorBoundary(u))];
    (window as any).__tldraw_shape_utils__ = all
    return all
  }, [])
  const bindingUtils = useMemo(() => [...defaultBindingUtils], [])
  const isPhone = typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches
  const tools = useMemo(() => [
    BrowseTool, MathNoteTool, VoiceNoteTool, TextSelectTool, FleetChatTool, FleetAgentsTool, FleetSearchTool, ClusterTool, PlaybackTool, TerminalTool, TaskInboxTool,
    ...(isPhone ? [PhoneHandTool] : []),
  ], [])

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

  // --- Sync error handling ---
  // When the sync store hits an error (e.g. ValidationError from unknown shape types),
  // show an error screen instead of an infinite spinner.
  if (storeWithStatus.status === 'error') {
    const err = storeWithStatus.error
    const errMsg = err?.message || String(err) || 'Unknown sync error'
    const isValidation = errMsg.includes('Validation') || errMsg.includes('validation')
    return (
      <div className="App">
        <div className="ErrorScreen">
          <div className="error-icon">⚠</div>
          <h2 className="error-title">Document sync failed</h2>
          <p className="error-message" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.8rem' }}>{errMsg}</p>
          {isValidation && (
            <p className="error-message" style={{ marginTop: 8 }}>
              This usually means the sync store contains shapes from an incompatible build.
            </p>
          )}
          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <button
              className="error-clear-btn"
              onClick={async () => {
                try {
                  const resp = await fetch(`/api/projects/${document.name}/sync/clear`, { method: 'POST' })
                  if (resp.ok) window.location.reload()
                  else alert(`Failed to clear: ${resp.statusText}`)
                } catch (e) {
                  alert(`Failed to clear: ${(e as Error).message}`)
                }
              }}
            >
              Clear broken shapes
            </button>
            <a className="error-home-link" href="/">← All documents</a>
          </div>
        </div>
      </div>
    )
  }

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
      // Register fleet shape placement tools (toolbar overflow only, no kbd shortcut)
      tools['fleet-chat'] = {
        id: 'fleet-chat',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>) as any,
        label: 'Fleet Chat',
        onSelect: () => _editor.setCurrentTool('fleet-chat'),
      }
      tools['fleet-agents'] = {
        id: 'fleet-agents',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="9" cy="7" r="4" />
          <path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          <path d="M21 21v-2a4 4 0 0 0-3-3.85" />
        </svg>) as any,
        label: 'Fleet Agents',
        onSelect: () => _editor.setCurrentTool('fleet-agents'),
      }
      tools['fleet-search'] = {
        id: 'fleet-search',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>) as any,
        label: 'Fleet Search',
        onSelect: () => _editor.setCurrentTool('fleet-search'),
      }
      // Register browse tool — pointer with starburst sparkle (interactive pages)
      tools['select'] = {
        id: 'select',
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
        onSelect: () => _editor.setCurrentTool('select'),
      }
      // Register cluster tool — server/grid icon
      tools['cluster'] = {
        id: 'cluster',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {/* Server rack outline */}
          <rect x="2" y="2" width="14" height="5" rx="1" />
          <rect x="2" y="8" width="14" height="5" rx="1" />
          {/* Status dots */}
          <circle cx="13.5" cy="4.5" r="0.8" fill="currentColor" stroke="none" />
          <circle cx="13.5" cy="10.5" r="0.8" fill="currentColor" stroke="none" />
          {/* Progress bar hint */}
          <line x1="4" y1="15" x2="9" y2="15" strokeWidth="2" />
          <line x1="9" y1="15" x2="14" y2="15" strokeWidth="1" strokeOpacity="0.3" />
        </svg>) as any,
        label: 'Cluster Monitor',
        onSelect: () => _editor.setCurrentTool('cluster'),
      }
      // Register playback-frame tool (kbd 'p')
      tools['playback-frame'] = {
        id: 'playback-frame',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="14" height="12" rx="2" />
          <polygon points="7,7 7,11 12,9" fill="currentColor" stroke="none" />
        </svg>) as any,
        label: 'Playback',
        kbd: 'p',
        onSelect: () => _editor.setCurrentTool('playback-frame'),
      }
      return tools
    },
  }), [])

  // Bottom panels content — passed via context into InFrontOfTheCanvas
  const bottomPanelsContent = (
    <div className="bottom-panels">
      {panelsLocal && refViewerRefs && editorRef.current &&
        !editorRef.current.getCurrentPageShapes().some((s: any) => s.type === 'fleet-docview') && (
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
      {screenshotCapture && editorRef.current && (
        <ScreenshotCapture
          mainEditor={editorRef.current}
          capture={screenshotCapture}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={LICENSE_KEY}
          onClose={() => setScreenshotCapture(null)}
          onGoThere={(bounds) => {
            editorRef.current?.centerOnPoint(
              { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
              { animation: { duration: 300 } }
            )
          }}
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
      {editorRef.current && (
        <AnnotationViewer
          mainEditor={editorRef.current}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={LICENSE_KEY}
        />
      )}
      {false && (
        <ShadowHistoryOverlay
          versions={shadowVersions}
          activeIdx={shadowActiveIdx}
          loading={shadowLoading}
          onScrub={handleShadowScrub}
          onClose={hideShadowOverlay}
        />
      )}
      <div className="build-pills-row">
        {storeWithStatus.status === 'synced-remote' && storeWithStatus.connectionStatus === 'offline' && (
          <span className="sync-offline-badge" title="Connection lost — signals and sync paused">⚡ offline</span>
        )}
        {isPresentation && <DraftPill />}{isPresentation && role === 'presenter' && <AnnotationVisibilityPill />}<FollowingBadge />
        <ViewPinBadge docName={document.name} />
        <PlaybackPill state={playbackState} />
        <BuildWarningPill warnings={buildWarnings} />
        {/* Build errors handled by fleet-docview shapes with 'errors' source */}
      </div>
      {editorRef.current && (
        <FleetHUD
          mainEditor={editorRef.current}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={LICENSE_KEY}
        />
      )}
    </div>
  )

  const agentPillContent = editorRef.current ? <AgentPill editor={editorRef.current} /> : null

  const versionStampContent = <VersionStamp docName={document.name} />

  return (
    <>
    <DocContext.Provider value={docContextValue}>
    <PanelContext.Provider value={panelContextValue}>
    <BottomPanelsContext.Provider value={bottomPanelsContent}>
    <AgentPillContext.Provider value={agentPillContent}>
    <VersionStampContext.Provider value={versionStampContent}>
    <Tldraw
        store={storeWithStatus}
        licenseKey={LICENSE_KEY}
        shapeUtils={shapeUtils}
        tools={tools}
        overrides={overrides}
        getShapeVisibility={getShapeVisibility}
        onMount={(editor) => {
          // Expose editor for debugging/puppeteer access
          (window as unknown as { __tldraw_editor__: Editor }).__tldraw_editor__ = editor
          editorRef.current = editor
          setEditorMounted(v => v + 1)

          // Patch isInAny NARROWLY for SelectionFg only.
          // tldraw's SelectionFg checks isInAny("select.idle","select.pointing_selection",
          // "select.pointing_shape","select.crop.idle") to decide whether to show handles.
          // BrowseTool uses browse.* states, so handles are hidden. We detect the exact
          // 4-arg SelectionFg call and remap it — leaving all other isInAny callers untouched.
          const FG_PATHS = new Set(['select.idle','select.pointing_selection','select.pointing_shape','select.crop.idle'])
          const origIsInAny = editor.isInAny.bind(editor)
          ;(editor as any).isInAny = (...paths: string[]) => {
            const result = origIsInAny(...paths)
            if (result) return result
            // Only remap the exact SelectionFg call (4 paths, all in FG_PATHS)
            if (paths.length === 4 && paths.every((p: string) => FG_PATHS.has(p))) {
              return origIsInAny('browse.idle') ||
                     origIsInAny('browse.pointing_selection') ||
                     origIsInAny('browse.pointing_shape')
            }
            return false
          }

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
            // Update all fleet-docview shapes that have 'ref' in their sources
            const dvTitle = (displayLabel || anchorId).replace(/^equation\./, 'eq ').replace(/^theorem\./, 'thm ')
            editor.getCurrentPageShapes()
              .filter((s: any) => s.type === 'fleet-docview')
              .filter((s: any) => {
                try { return JSON.parse(s.props?.sources || '["ref"]').includes('ref') } catch { return true }
              })
              .forEach((dvShape: any) => {
                if (dvShape.isLocked) editor.updateShape({ id: dvShape.id, type: dvShape.type, isLocked: false })
                editor.updateShape({
                  id: dvShape.id, type: dvShape.type,
                  props: { ...dvShape.props, label: anchorId, page: pageIdx + 1, yTop, yBottom, title: dvTitle },
                })
              })
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
          // Guard: track which editor was restored. Skips React Strict Mode
          // double-invokes (same editor), but re-runs when a new editor is
          // created (e.g. after Vite HMR causes useSync to return a new store).
          if (restoredEditorRef.current !== editor) {
            restoredEditorRef.current = editor
            const session = loadSession()
            setTimeout(() => {
              if (session?.pageId) {
                // Restore TLDraw page (multipage HTML) before restoring camera
                const pages = editor.getPages()
                if (pages.some(p => p.id === session.pageId)) {
                  editor.setCurrentPage(session.pageId as any)
                }
              }
              if (initialCamera) {
                // URL camera params override session restore
                if (initialCamera.page) {
                  const pages = editor.getPages()
                  const target = pages.find(p => p.name === initialCamera.page || p.id === initialCamera.page)
                  if (target) editor.setCurrentPage(target.id as any)
                }
                editor.setCamera({ x: initialCamera.x, y: initialCamera.y, z: initialCamera.z })
              } else if (session?.camera) {
                editor.setCamera(session.camera)
              }
              if (isPhone) {
                // Phone: fit text column width on load (unless URL camera was specified)
                // Defer slightly so SVG content is injected and we can measure text bounds
                if (!initialCamera && !session?.camera) {
                  const fitToContent = () => {
                    const pageShapes = editor.getCurrentPageShapes().filter(s => (s.type as string) === 'svg-page')
                    if (pageShapes.length === 0) return
                    const first = pageShapes.sort((a, b) => (a as any).y - (b as any).y)[0]
                    const b = editor.getShapePageBounds(first.id)
                    if (!b) return
                    // Try to find text column bounds from DOM
                    const el = window.document.querySelector(`[data-shape-id="${first.id}"]:not(.tl-shape-background)`)
                    const svg = el?.querySelector('svg')
                    const vp = editor.getViewportScreenBounds()
                    if (svg?.viewBox?.baseVal?.width) {
                      const vb = svg.viewBox.baseVal
                      const texts = svg.querySelectorAll('text')
                      let minX = Infinity, maxX = -Infinity
                      for (const t of texts) {
                        if (t.closest('defs')) continue
                        const x = parseFloat(t.getAttribute('x') || '0')
                        const len = (t as SVGTextContentElement).getComputedTextLength?.() || 0
                        if (x < minX) minX = x
                        if (x + len > maxX) maxX = x + len
                      }
                      if (minX < maxX) {
                        const sx = b.width / vb.width
                        const colMinX = b.minX + minX * sx
                        const colW = (maxX - minX) * sx
                        const z = vp.width / colW
                        editor.setCamera({ x: -colMinX, y: -b.minY, z })
                        return
                      }
                    }
                    // Fallback: full page width
                    const z = vp.width / b.width
                    editor.setCamera({ x: -b.minX, y: -b.minY, z })
                  }
                  // Try immediately, retry after SVG injection
                  fitToContent()
                  setTimeout(fitToContent, 500)
                }
                // Phone: always start in phone-hand tool for axis-locked scroll
                editor.setCurrentTool('phone-hand')
              } else if (session?.tool) {
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

              // Camera broadcast: gated on camera-link toggle; slides also gate on presenter role
              react('broadcast-camera', () => {
                const cam = editor.getCamera() // subscribe
                if (!getCameraLinked()) return
                if (isPresentation && getRole() !== 'presenter') return
                if (suppressBroadcastRef.current) return
                if (broadcastTimerRef.current) clearTimeout(broadcastTimerRef.current)
                broadcastTimerRef.current = setTimeout(() => {
                  if (suppressBroadcastRef.current) return
                  if (isPresentation && getRole() !== 'presenter') return
                  broadcastCamera(cam.x, cam.y, cam.z)
                }, 30)
              })

              react('save-tool', () => {
                editor.getCurrentToolId() // subscribe
                saveSession()
              })

              // Browse bounce-back removed — BrowseTool now subclasses SelectTool
              // and handles fleet/HTML routing in its own Idle state. No tool switching needed.
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
            // Slides keyboard/swipe nav handled by SlidesNavigator component
          }
          window.addEventListener('keydown', handleKeyDown)

          // Dismiss reload-sourced change highlights on canvas click
          {
            const c = editor.getContainer()
            c.addEventListener('pointerdown', () => {
              if (changedPages.size > 0) dismissAllChanges()
            })
          }

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
      <MarkdownDropHandler />
      <TocDropTargetManager />
      {isPresentation && <SlideNavWrapper document={document} />}
    </Tldraw>
    </VersionStampContext.Provider>
    </AgentPillContext.Provider>
    </BottomPanelsContext.Provider>
    </PanelContext.Provider>
    </DocContext.Provider>
    {new URLSearchParams(window.location.search).has('input') && (
      <FootControlDebug footController={footInstance} clickDetector={clickInstance} />
    )}
    </>
  )
}

