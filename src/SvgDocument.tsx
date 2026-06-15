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
import { DocClipShapeUtil } from './shapes/DocClipShape'
import { FleetPillShapeUtil } from './shapes/FleetPillShape'
import { FleetSearchShapeUtil } from './shapes/FleetSearchShape'
import { FleetInboxShapeUtil } from './shapes/FleetInboxShape'
import { FleetTouchInboxShapeUtil } from './shapes/FleetTouchInboxShape'
import { getMyAnchorId, isMyFleetShape, FLEET_SHAPE_TYPES } from './shapes/fleet-utils'
import { ClusterShapeUtil } from './shapes/ClusterShape'
import { TerminalShapeUtil } from './shapes/TerminalShape'
import { ReaperShapeUtil } from './shapes/ReaperShape'
import { OutlineShapeUtil } from './shapes/OutlineShape'
import { GraphNodeShapeUtil } from './shapes/GraphNodeShape'
import { GraphExplainShapeUtil } from './shapes/GraphExplainShape'
import { materializeChain } from './graphNativeMaterialize'
import { InlineDocShapeUtil } from './shapes/InlineDocShape'
import { DocVersionShapeUtil } from './shapes/DocVersionShape'
import { PlaybackFrameShapeUtil } from './shapes/PlaybackFrameShape'
import { HighlighterSlider } from './shapes/HighlighterSliderShape'
import { ToolNameHud } from './overlays/ToolNameHud'
import { getSvgViewBox, setNavigateToAnchor, setOnSourceClick, anchorIndex, setChangeHighlights, dismissAllChanges, changedPages } from './stores'
import { BrowseTool } from './tools/BrowseTool/BrowseTool'
import { PhoneHandTool } from './tools/PhoneHandTool'
import { MathNoteTool } from './tools/MathNoteTool'
import { VoiceNoteTool } from './tools/VoiceNoteTool'
import { TextSelectTool } from './tools/TextSelectTool'
import { FleetChatTool } from './tools/FleetChatTool'
import { FleetAgentsTool } from './tools/FleetAgentsTool'
import { FleetSearchTool } from './tools/FleetSearchTool'
import { FleetInboxTool } from './tools/FleetInboxTool'
import { ClusterTool } from './tools/ClusterTool'
import { ReaperTool } from './tools/ReaperTool'
import { TerminalTool } from './tools/TerminalTool'
import { PlaybackTool } from './tools/PlaybackTool'
import { TaskInboxShapeUtil } from './shapes/TaskInboxShape'
import { TaskInboxTool } from './tools/TaskInboxTool'
import { RibbonEraserTool } from './tools/RibbonEraserTool'
import { RibbonHighlightTool } from './tools/RibbonHighlightTool'
import { RibbonLane } from './shapes/RibbonLane'
import { initSignalConnection, teardownSignalConnection, isSignalConnected, dispatchSignalDirect, writeSignal, broadcastCamera, broadcastPresenter, onBuildStatusSignal, onReloadSignal, onViewPinSignal, onCompareSignal, onFileUpdatedSignal, onGraphDrawSignal, type BuildError, type BuildWarning } from './useYjsSync'
import { useSync } from '@tldraw/sync'
import { appendToken } from './authToken'
import { DocumentPanel, PhoneOverlay, HighlighterButton, SemanticHighlightPill, VoiceNoteButton, MicToggleButton, VoiceTargetFollower } from './DocumentPanel'
import { AgentAttentionOverlay } from './overlays/AgentAttentionOverlay'
import { FleetToolGhost } from './overlays/FleetToolGhost'
import { RecognizeButton } from './overlays/RecognizeButton'
import { PenHelperButtons, DarkModeSync } from './toolbar/ToolbarComponents'
import { FormatToolbar } from './toolbar/FormatToolbar'
import { DocContext, PanelContext, BottomPanelsContext, AgentPillContext } from './PanelContext'
import { NoteDropHandler } from './NoteDropHandler'
import { MarkdownDropHandler } from './MarkdownDropHandler'
import { setCurrentDocumentInfo, pageSpacing, type SvgDocument } from './svgDocumentLoader'
import { ScrollyOverlay } from './overlays/ScrollyOverlay'
import { ScreenshotCapture } from './overlays/ScreenshotCapture'
import { FleetHUD, fleetHudOpenRef } from './overlays/FleetHUD'

import { BuildWarningPill } from './pills/BuildWarningPill'
import { BuildErrorPill } from './pills/BuildErrorPill'
import { SyncErrorPill } from './pills/SyncErrorPill'
import { BuildProgressPill } from './pills/BuildProgressPill'
import { AnnotationVisibilityPill } from './pills/AnnotationVisibilityPill'
import { DraftPill } from './pills/DraftPill'
import { FollowingBadge } from './pills/FollowingBadge'
import { FleetIconPill } from './pills/FleetIconPill'
import { initRole, getRole, toggleRole, subscribeRole } from './viewerRole'
import { setDraftMode } from './annotationVisibility'
import { ChangePreviewPanel } from './overlays/ChangePreviewPanel'
import { AnnotationViewer } from './overlays/AnnotationViewer'
import { useHistoryOverlay } from './hooks/useHistoryOverlay'
import { initSnapshots } from './snapshotStore'
import { PDF_HEIGHT } from './layoutConstants'
import { setupPulseForDiffLayout } from './diffHelpers'
import { openInEditor } from './texsync'
import { setupSvgEditor, anchorIdToLabel, type ReloadResult } from './editorSetup'
import * as sourceMap from './sourceMap'
import { getFormatConfig, homeTool as getHomeTool } from './formatConfig'
import { useSnapshotTimeline } from './hooks/useSnapshotTimeline'
import { useCameraLink } from './hooks/useCameraLink'
import { getCameraLinked } from './cameraLink'
import { useDiffToggle } from './hooks/useDiffToggle'
import { useProofToggle } from './hooks/useProofToggle'
import { useYjsSignals } from './hooks/useYjsSignals'
import { useSyncedPlayback } from './hooks/useSyncedPlayback'
import { useFleetTheme, getStoredScheme } from './hooks/useFleetTheme'
import { useTimelineOverlay } from './hooks/useTimelineOverlay'
import { useDocAutoOpen } from './hooks/useDocAutoOpen'
import { useFootControl } from './hooks/useFootControl'
import { usePanMode } from './hooks/usePanMode'
import { FootControlDebug } from './footControlDebug'
import { subscribeInputModes, getFootEnabled, getClicksEnabled, getWhistleEnabled, getHissEnabled } from './inputModes'
import { useShadowOverlay } from './hooks/useShadowOverlay'
import { useDividerDiff } from './hooks/useDividerDiff'
import { ShadowHistoryOverlay } from './overlays/ShadowHistoryOverlay'
import { PlaybackPill } from './pills/PlaybackPill'
import { SlidesNavigator } from './SlidesNavigator'

// Sync server URL - use env var, or derive from window.location
// Dev mode (Vite on 5173): connect to sync server on 5176
// Production (unified server): same host, ws/wss based on protocol
const SYNC_SERVER = import.meta.env.VITE_SYNC_SERVER ||
  (import.meta.env.DEV
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:5176`
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
  const editor = useEditor()
  const [sentinel, setSentinel] = useState<{ commitHash: string; buildReadyAt: number } | null>(null)
  const [history, setHistory] = useState<Array<{ hash: string; timestamp: number }>>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [hovering, setHovering] = useState(false)
  const lastReloadAtRef = useRef<number>(0)
  const prevHashRef = useRef<string | null>(null)

  // Watch the Yjs sentinel — updates exactly when the shadow git commit completes.
  // Yjs is convergent: reconnecting always delivers the latest state.
  useEffect(() => {
    if (!editor) return
    const read = () => {
      const s = editor.store.get('shape:doc-version--sentinel' as TLShapeId)
      const p = (s as any)?.props
      if (!p?.commitHash || p.commitHash === 'unknown') return null
      return { commitHash: p.commitHash as string, buildReadyAt: (p.buildReadyAt || p.timestamp || 0) as number }
    }
    const v = read()
    if (v) {
      setSentinel(v)
      // Baseline: treat current build as already-reloaded on first mount
      if (lastReloadAtRef.current === 0) lastReloadAtRef.current = v.buildReadyAt
    }
    return editor.store.listen(() => {
      const v = read()
      if (v) setSentinel(v)
    }, { source: 'remote', scope: 'all' })
  }, [editor])

  // When the commit hash changes: fetch version history + check for missed reload.
  useEffect(() => {
    if (!sentinel?.commitHash || sentinel.commitHash === prevHashRef.current) return
    prevHashRef.current = sentinel.commitHash

    fetch(`/api/projects/${docName}/history/shadow`)
      .then(r => r.ok ? r.json() : null)
      .then(raw => {
        const data: Array<{ hash: string; timestamp: number }> = raw?.versions || raw
        if (data?.length > 0) { setHistory(data.slice(0, MAX_VISIBLE_VERSIONS)); setActiveIdx(0) }
      }).catch(e => console.warn('[viewer] shadow history fetch failed:', e.message))

    // If SVGs were ready but we missed the reload signal, trigger a reload now.
    if (lastReloadAtRef.current > 0 && sentinel.buildReadyAt > lastReloadAtRef.current + 5000) {
      dispatchSignalDirect('signal:reload', { type: 'full', timestamp: Date.now() })
    }
  }, [sentinel?.commitHash, docName])

  // Track reload signals to detect misses.
  useEffect(() => {
    return onReloadSignal(sig => { lastReloadAtRef.current = sig.timestamp })
  }, [])

  // Watchdog: periodically re-check staleness in case the one-shot guard was consumed
  // without a successful reload (rapid builds, WS reconnect with same hash).
  const sentinelBuildReadyAt = sentinel?.buildReadyAt ?? 0
  useEffect(() => {
    if (!sentinelBuildReadyAt) return
    const id = setInterval(() => {
      if (lastReloadAtRef.current === 0) return
      if (sentinelBuildReadyAt > lastReloadAtRef.current + 10_000) {
        console.log('[viewer] watchdog: stale by', sentinelBuildReadyAt - lastReloadAtRef.current, 'ms — triggering reload')
        dispatchSignalDirect('signal:reload', { type: 'full', timestamp: Date.now() })
      }
    }, 30_000)
    return () => clearInterval(id)
  }, [sentinelBuildReadyAt])

  const handleClick = useCallback((idx: number) => {
    if (idx === 0) return
    const v = history[idx]
    if (!v) return
    ;(window as any).__shadowScrubVersion?.(v)
    setActiveIdx(idx)
  }, [history])

  if (!sentinel) return null

  // Use history if loaded; fall back to a single synthetic entry from the sentinel.
  const display: Array<{ hash: string; timestamp: number }> = history.length > 0
    ? history
    : [{ hash: sentinel.commitHash, timestamp: sentinel.buildReadyAt }]

  return (
    <div
      className="version-stamp"
      onPointerDown={e => e.stopPropagation()}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {display.map((v, i) => {
        // Most recent entry: use buildReadyAt (when SVGs were published) not git commit time
        const ts = i === 0 ? sentinel.buildReadyAt || v.timestamp : v.timestamp
        const hash7 = v.hash.slice(0, 7)
        const time = new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        const isActive = i === activeIdx
        const baseOpacity = isActive ? 0.7 : Math.max(0.08, 0.35 - i * 0.07)
        return (
          <div
            key={v.hash}
            className={`version-stamp-entry${isActive ? ' active' : ''}`}
            style={{ opacity: baseOpacity }}
            onClick={() => handleClick(i)}
            title={`${hash7} — ${new Date(ts).toLocaleString()}`}
          >
            {time}{hovering && i === 0 && <span className="version-stamp-hash"> · {hash7}</span>}
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

  // An agent authored an argument graph → materialize it on this doc's canvas.
  useEffect(() => {
    return onGraphDrawSignal((sig) => {
      const editor = editorRef.current
      if (!editor || !sig?.chain) return
      if (sig.replace) {
        const ids = editor.getCurrentPageShapes()
          .filter((s: any) => s.type === 'graph-node' || s.meta?.graphEdge)
          .map((s: any) => s.id)
        if (ids.length) editor.run(() => editor.deleteShapes(ids), { history: 'ignore' })
      }
      try { materializeChain(editor, sig.chain) } catch (e) { console.error('[graph] materialize failed', e) }
    })
  }, [])

  // --- Cross-cutting refs shared by hooks ---
  const shapeIdSetRef = useRef<Set<TLShapeId>>(new Set())
  const shapeIdsArrayRef = useRef<TLShapeId[]>([])
  const updateCameraBoundsRef = useRef<((bounds: any) => void) | null>(null)
  const ensurePagesAtBottomRef = useRef<(() => void) | null>(null)
  const focusChangeRef = useRef<((currentPage: number) => void) | null>(null)

  // --- Screenshot capture state ---
  const [screenshotCapture, setScreenshotCapture] = useState<import('./hooks/useYjsSignals').ScreenshotCaptureState | null>(null)

  // --- Panels local toggle (hide bottom panels locally) ---
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


  // Remap warnings from reload (merged into buildWarnings below)
  const [remapWarnings, setRemapWarnings] = useState<BuildWarning[]>([])

  // Fleet playback — listen for BroadcastChannel and swap annotation shapes
  const playbackState = useSyncedPlayback(editorRef, docName)

  // Spatial timeline overlay — activity scatter plot
  const { timelineActive, toggleTimeline } = useTimelineOverlay(editorRef, document, docName)

  // Shadow history scrubber
  const {
    shadowTimeBounds, shadowActiveVersion, shadowLoading, shadowVisible,
    shadowColumnX, shadowYOffset, shadowChangelog,
    toggleShadowOverlay, hideShadowOverlay, handleShadowScrubTime, handleShadowStep, realignShadow,
  } = useShadowOverlay(editorRef, document, docName, shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef)

  // Divider diff: draw on the gap between columns to trigger word-level diff
  useDividerDiff(editorRef, docName, shadowActiveVersion?.hash ?? null, shadowColumnX, shadowYOffset)

  // Side-by-side version comparison — relay Yjs signal to window event
  useEffect(() => {
    const unsub = onCompareSignal((data) => {
      window.dispatchEvent(new CustomEvent('tlda-compare', { detail: data }))
    })
    return unsub
  }, [])
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

  // Auxiliary mouse button (3 or 4) toggles pan mode: move mouse to pan canvas / scroll chat
  usePanMode(editorRef)

  useYjsSignals({
    editorRef, document,
    diffDataRef, setDiffFetchSeq,
    proofDataRef, setProofDataReady, setProofFetchSeq,
    panelsLocalRef,
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

  // File-backed notes: update shape text when the backing file changes on disk
  useEffect(() => {
    return onFileUpdatedSignal((signal) => {
      const editor = editorRef.current
      if (!editor) return
      for (const record of editor.store.allRecords()) {
        if (record.typeName !== 'shape') continue
        const shape = record as any
        if (shape.type !== 'math-note') continue
        if (shape.props.backingFile !== signal.filePath) continue
        if (shape.props.text === signal.content) continue
        if (editor.getEditingShapeId() === shape.id) continue
        editor.updateShape({ id: shape.id, type: 'math-note' as any, props: { text: signal.content } })
      }
    })
  }, [])

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

  // Mark html.is-scrolling during active wheel scroll so CSS can suppress opacity transitions.
  // wheel fires for all scroll input: mouse wheel, Magic Mouse, trackpad.
  // Logitech Lift pan mode is handled in CSS via body.tlda-pan-mode (set by usePanMode).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const onWheel = () => {
      globalThis.document.documentElement.classList.add('is-scrolling')
      clearTimeout(timer)
      timer = setTimeout(() => globalThis.document.documentElement.classList.remove('is-scrolling'), 400)
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      window.removeEventListener('wheel', onWheel)
      clearTimeout(timer)
      globalThis.document.documentElement.classList.remove('is-scrolling')
    }
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
      InFrontOfTheCanvas: () => <><RibbonLane /><DocumentPanel /><PhoneOverlay /><HighlighterButton /><VoiceNoteButton /><MicToggleButton /><VoiceTargetFollower /><SemanticHighlightPill /><AgentAttentionCanvas /><RecognizeButton /><BottomPanelsSlot /><AgentPillSlot /><HighlighterSlider /><ToolNameHud /><VersionStampSlot /><FleetToolGhost /></>,
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
    targets: document.targets,
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
    selectedChangeId,
    onSelectChange: handleSelectChange,
    buildErrors,
    buildWarnings,
    timelineActive,
    onToggleTimeline: toggleTimeline,
    shadowHistoryVisible: shadowVisible,
    onToggleShadowHistory: toggleShadowOverlay,
    shadowActiveVersion,
  }), [docKey, hasDiffBuiltin, hasDiffToggle, diffMode, diffLoading, toggleDiff, proofMode, proofLoading, proofDataReady, toggleProof, role, panelsLocal, togglePanelsLocal, snapshotCount, snapshotSliderIdx, handleSliderChange, historyEntries, activeHistoryIdx, historyLoading, historyChangedPages, historyChanges, handleHistoryChange, selectedChangeId, handleSelectChange, buildErrors, buildWarnings, timelineActive, toggleTimeline, shadowVisible, toggleShadowOverlay, shadowActiveVersion])

  // Hide fleet shapes on the main canvas in two cases:
  // 1. Non-owned fleet shapes (belong to another user or orphans) — always hidden
  // 2. Owned fleet shapes when HUD is open — the HUD renders its own copies
  const getShapeVisibility = useCallback((shape: any) => {
    if (FLEET_SHAPE_TYPES.has(shape.type)) {
      if (!isMyFleetShape(shape)) return 'hidden' as const
      if (fleetHudOpenRef.current) return 'hidden' as const
    }
    return undefined
  }, [])

  const shapeUtils = useMemo(() => {
    // Suppress the default hover/selection indicator on highlight shapes —
    // it draws a blue path outline that competes with our text glow effect
    class QuietHighlightShapeUtil extends HighlightShapeUtil {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      override indicator() { return null as any }
    }
    const utils = defaultShapeUtils.map(u =>
      u === HighlightShapeUtil ? QuietHighlightShapeUtil : u
    )
    // Wrap every custom shape util with an error boundary so a single broken shape
    // renders an error placeholder instead of crashing the entire app.
    const customUtils = [MathNoteShapeUtil, HtmlPageShapeUtil, SvgPageShapeUtil, SvgFigureShapeUtil, TocDropTargetShapeUtil, ReadingAssistBarShapeUtil, UnderstandingLineShapeUtil, TimelineOverlayShapeUtil, ZoomableImageShapeUtil, FleetChatShapeUtil, FleetAgentsShapeUtil, FleetPillShapeUtil, FleetSearchShapeUtil, FleetInboxShapeUtil, FleetTouchInboxShapeUtil, FleetDocViewShapeUtil, DocClipShapeUtil, InlineDocShapeUtil, DocVersionShapeUtil, ClusterShapeUtil, TerminalShapeUtil, TaskInboxShapeUtil, PlaybackFrameShapeUtil, ReaperShapeUtil, OutlineShapeUtil, GraphNodeShapeUtil, GraphExplainShapeUtil]
    const all = [...utils, ...customUtils.map(u => withShapeErrorBoundary(u))];
    (window as any).__tldraw_shape_utils__ = all
    return all
  }, [])
  const bindingUtils = useMemo(() => [...defaultBindingUtils], [])
  const isPhone = typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches
  const tools = useMemo(() => [
    BrowseTool, MathNoteTool, VoiceNoteTool, TextSelectTool, FleetChatTool, FleetAgentsTool, FleetSearchTool, FleetInboxTool, ClusterTool, ReaperTool, PlaybackTool, TerminalTool, TaskInboxTool, RibbonEraserTool, RibbonHighlightTool,
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
    const isValidation = errMsg.includes('Validation') || errMsg.includes('validation') || errMsg.includes('INVALID_RECORD')
    return (
      <div className="App">
        <div className="ErrorScreen">
          <div className="error-icon">⚠</div>
          <h2 className="error-title">Document sync failed</h2>
          <p className="error-message" style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.8rem' }}>{errMsg}</p>
          {isValidation && (
            <p className="error-message" style={{ marginTop: 8 }}>
              Schema validation error — a shape prop type mismatch between client and server.
              Check server logs for the specific field that failed validation.
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
      tools['fleet-inbox'] = {
        id: 'fleet-inbox',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>) as any,
        label: 'Fleet Inbox',
        onSelect: () => _editor.setCurrentTool('fleet-inbox'),
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
      // Register reaper tool — scythe/process icon
      tools['fleet-reaper'] = {
        id: 'fleet-reaper',
        icon: (<svg className="tlui-icon" style={{ backgroundColor: 'transparent' }} width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {/* Skull outline */}
          <circle cx="9" cy="8" r="5.5" />
          {/* Eyes */}
          <circle cx="7" cy="7" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="11" cy="7" r="1.2" fill="currentColor" stroke="none" />
          {/* Teeth */}
          <line x1="7.5" y1="11" x2="7.5" y2="13" strokeWidth="1" />
          <line x1="9" y1="11" x2="9" y2="13.5" strokeWidth="1" />
          <line x1="10.5" y1="11" x2="10.5" y2="13" strokeWidth="1" />
        </svg>) as any,
        label: 'Reaper',
        onSelect: () => _editor.setCurrentTool('fleet-reaper'),
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
      {screenshotCapture && editorRef.current && (
        <ScreenshotCapture
          mainEditor={editorRef.current}
          capture={screenshotCapture}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={LICENSE_KEY}
          onClose={() => setScreenshotCapture(null)}
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
      {shadowVisible && shadowTimeBounds && (
        <ShadowHistoryOverlay
          timeBounds={shadowTimeBounds}
          activeVersion={shadowActiveVersion ?? null}
          loading={shadowLoading}
          onScrubTime={handleShadowScrubTime}
          onStep={handleShadowStep}
          onClose={hideShadowOverlay}
          onRealign={realignShadow}
          changelog={shadowChangelog.commits.length > 0 ? shadowChangelog : undefined}
        />
      )}
      <div className="build-pills-row">
        {storeWithStatus.status === 'synced-remote' && storeWithStatus.connectionStatus === 'offline' && (
          <span className="sync-offline-badge" title="Connection lost — signals and sync paused">⚡ offline</span>
        )}
        {isPresentation && <DraftPill />}{isPresentation && role === 'presenter' && <AnnotationVisibilityPill />}<FollowingBadge />
        <ViewPinBadge docName={document.name} />
        <PlaybackPill state={playbackState} />
        <SyncErrorPill />
        <BuildErrorPill />
        <BuildWarningPill warnings={buildWarnings}>
          <BuildProgressPill />
        </BuildWarningPill>
        {editorRef.current && <FleetIconPill mainEditor={editorRef.current} />}
        {/* Build errors: red BuildErrorPill (reads errorsJson from the doc-version sentinel) */}
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

  // AgentPill replaced by FleetIconPill in build-pills-row
  const agentPillContent = null

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

          editor.user.updateUserPreferences({ colorScheme: getStoredScheme() })

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

          // Set up hyperref link navigation: update fleet-docview shapes
          // Load source map (labels index) for ref resolution.
          // For multi-target docs, pass targets so per-target source-maps are merged
          // with global page offsets — the bare alias only covers the primary target.
          sourceMap.load(document.name, document.targets?.map(t => ({ name: t.name, pages: t.pages })))

          setNavigateToAnchor((anchorId: string, title: string) => {
            let page = -1
            let yTop = 0, yBottom = PDF_HEIGHT
            let labelForRegion = anchorId

            // 1. Resolve page from source map (works for all labels, even unloaded pages)
            const titleParts = (title || anchorId).split('.')
            const thmNum = titleParts.slice(1).join('.')
            const smMatch = sourceMap.resolveLabel(anchorId) || sourceMap.resolveLabel(thmNum)
            if (smMatch && smMatch.page >= 1 && smMatch.page <= document.pages.length) {
              page = smMatch.page
              labelForRegion = smMatch.label
              yBottom = PDF_HEIGHT * 0.3
            }

            // 2. Refine position from SVG anchor index if available (has precise viewBox)
            const entry = anchorIndex.get(anchorId)
            if (entry) {
              const svgPageIdx = document.pages.findIndex(p => p.shapeId === entry.pageShapeId)
              if (svgPageIdx >= 0) page = svgPageIdx + 1
              const svgVB = getSvgViewBox(entry.pageShapeId)
              if (svgVB && entry.viewBox) {
                const parts = entry.viewBox.split(/\s+/).map(Number)
                if (parts.length === 4) {
                  const [, svgY, , svgH] = parts
                  yTop = (svgY - svgVB.minY) / svgVB.height * PDF_HEIGHT
                  yBottom = yTop + svgH / svgVB.height * PDF_HEIGHT
                }
              }
            }

            if (page < 1) return

            const { displayLabel } = anchorIdToLabel(title || (smMatch ? `${smMatch.type}.${smMatch.number}` : anchorId))

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
                  props: { ...dvShape.props, label: labelForRegion, page, yTop, yBottom, title: dvTitle },
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

          // SVG page content is fetched lazily by each SvgPageShape when it
          // enters the viewport — no bulk fetch needed here.

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

            setOnSourceClick((shapeId: string, clickYFraction: number) => {
              const page = shapeToPage.get(shapeId)
              if (!page) return

              const pdfY = clickYFraction * PDF_HEIGHT
              const match = sourceMap.pageToSource(page, pdfY)
              if (!match) return

              openInEditor(document.name, match.file, match.line)
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
              window.dispatchEvent(new Event('camera-restored'))
              // Recompute HUD panOffset ONLY if no saved position exists.
              // With a saved panOffset (anchor shape from a previous session),
              // don't nuke it. Without one (first visit), recompute after camera
              // restoration so pageToScreen() uses the correct camera.
              if (!editor.getShape(getMyAnchorId() as any)) {
                requestAnimationFrame(() => {
                  requestAnimationFrame(() => {
                    // preserveAnchor: this is a plain reload, where a missing anchor
                    // may just be unsynced/identity-unresolved (large rooms deliver it
                    // late). The HUD should recompute a provisional default but MUST NOT
                    // delete the saved anchor — see onReset. Destructive resets
                    // (layout switch, emergency recovery) dispatch without this flag.
                    window.dispatchEvent(new CustomEvent('fleet-hud-reset', { detail: { preserveAnchor: true } }))
                  })
                })
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

