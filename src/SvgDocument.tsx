import { useMemo, useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  Tldraw,
  react,
  useEditor,
  useValue,
  DefaultToolbar,
  DefaultColorStyle,
  DefaultSizeStyle,
  TldrawUiMenuToolItem,
  useTools,
  useIsToolSelected,
} from 'tldraw'
import {
  SelectToolbarItem,
  HandToolbarItem,
  DrawToolbarItem,
  HighlightToolbarItem,
  EraserToolbarItem,
  ArrowToolbarItem,
  TextToolbarItem,
  AssetToolbarItem,
  RectangleToolbarItem,
  EllipseToolbarItem,
  LineToolbarItem,
  LaserToolbarItem,
} from 'tldraw'
import type { TLComponents, Editor, TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { MathNoteShapeUtil, setMathNoteEntryMode } from './MathNoteShape'
import { HtmlPageShapeUtil } from './HtmlPageShape'
import { SvgPageShapeUtil, getSvgViewBox, setNavigateToAnchor, anchorIndex } from './SvgPageShape'
import { MathNoteTool } from './MathNoteTool'
import { TextSelectTool } from './TextSelectTool'
import { useYjsSync, getYRecords, writeSignal, broadcastCamera } from './useYjsSync'
import { DocumentPanel, PingButton } from './DocumentPanel'
import { PanelContext } from './PanelContext'
import { setCurrentDocumentInfo, pageSpacing, type SvgDocument, type LabelRegion } from './svgDocumentLoader'
import { ProofStatementOverlay } from './ProofStatementOverlay'
import { RefViewer } from './RefViewer'
import { initSnapshots, getSnapshots } from './snapshotStore'
import { PDF_HEIGHT } from './layoutConstants'
import { setupPulseForDiffLayout } from './diffHelpers'
import { setupSvgEditor, anchorIdToLabel } from './editorSetup'
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

// Inner component to set up Yjs sync (needs useEditor context)
function YjsSyncProvider({ roomId, onInitialSync }: { roomId: string; onInitialSync?: () => void }) {
  const editor = useEditor()
  useYjsSync({
    editor,
    roomId,
    serverUrl: SYNC_SERVER,
    onInitialSync: () => {
      // Don't remap annotations here — positions from Yjs are authoritative.
      // remapAnnotations only runs after a document rebuild (in reloadPages),
      // not on every connect/reconnect (which would snap user-dragged notes
      // back to their source anchor positions).
      onInitialSync?.()
    }
  })
  return null
}

interface SvgDocumentEditorProps {
  document: SvgDocument
  roomId: string
  diffConfig?: { basePath: string }
}


function MathNoteToolbarItem() {
  const tools = useTools()
  const isSelected = useIsToolSelected(tools['math-note'])
  return <TldrawUiMenuToolItem toolId="math-note" isSelected={isSelected} />
}

function TextSelectToolbarItem() {
  const tools = useTools()
  const isSelected = useIsToolSelected(tools['text-select'])
  return <TldrawUiMenuToolItem toolId="text-select" isSelected={isSelected} />
}

function ExitPenModeButton() {
  const editor = useEditor()
  const isPenMode = useValue('is pen mode', () => editor.getInstanceState().isPenMode, [editor])
  if (!isPenMode) return null
  return (
    <button
      className="exit-pen-mode-btn"
      onClick={() => editor.updateInstanceState({ isPenMode: false })}
    >
      <span className="exit-pen-mode-stack">
        <span className="exit-pen-mode-pen">{'\u270F\uFE0E'}</span>
        <span className="exit-pen-mode-x">{'\u2715'}</span>
      </span>
    </button>
  )
}

/** Sync TLDraw dark mode to <html data-theme> for portaled elements */
function DarkModeSync() {
  const editor = useEditor()
  const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
  useEffect(() => {
    globalThis.document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [isDark])
  return null
}

export function SvgDocumentEditor({ document, roomId, diffConfig }: SvgDocumentEditorProps) {
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
  useEffect(() => { panelsLocalRef.current = panelsLocal }, [panelsLocal])
  const togglePanelsLocal = useCallback(() => { setPanelsLocal(prev => !prev) }, [])

  // --- Hooks ---
  const { snapshotSliderIdx, snapshotCount, handleSliderChange } = useSnapshotTimeline(document)

  const { cameraLinked, setCameraLinked, cameraLinkedRef, suppressBroadcastRef, broadcastTimerRef, toggleCameraLink } = useCameraLink(editorRef)

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

  useYjsSignals({
    editorRef, document,
    diffDataRef, setDiffFetchSeq,
    proofDataRef, setProofDataReady, setProofFetchSeq,
    setRefViewerRefs, refViewerLineRef, panelsLocalRef,
  })

  // --- Shared portal for bottom-left panels (ref viewer + proof overlay) ---
  const bottomPanelsRef = useRef<HTMLDivElement | null>(null)
  if (!bottomPanelsRef.current) {
    bottomPanelsRef.current = window.document.createElement('div')
    bottomPanelsRef.current.className = 'bottom-panels'
    window.document.body.appendChild(bottomPanelsRef.current)
  }
  useEffect(() => {
    return () => {
      bottomPanelsRef.current?.remove()
      bottomPanelsRef.current = null
    }
  }, [])

  // Guard: skip keyboard shortcuts when a DOM input/textarea has focus
  function isInputFocused() {
    const tag = window.document.activeElement?.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || (window.document.activeElement as HTMLElement)?.isContentEditable
  }

  // Keyboard shortcut: 'i' or ':' to enter math note in vim mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'i' && e.key !== ':') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isInputFocused()) return
      const editor = editorRef.current
      if (!editor) return
      if (editor.getEditingShapeId()) return
      const selected = editor.getSelectedShapeIds()
      if (selected.length !== 1) return
      const shape = editor.getShape(selected[0])
      if (!shape || (shape.type as string) !== 'math-note') return
      e.preventDefault()
      setMathNoteEntryMode(e.key as 'i' | ':')
      editor.setEditingShape(shape.id)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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

  const components = useMemo<TLComponents>(
    () => ({
      PageMenu: null,
      SharePanel: null,
      MainMenu: null,
      Toolbar: (props) => (
        <DefaultToolbar {...props} orientation="vertical">
          <SelectToolbarItem />
          <HandToolbarItem />
          <DrawToolbarItem />
          <HighlightToolbarItem />
          <EraserToolbarItem />
          <TextSelectToolbarItem />
          <ArrowToolbarItem />
          <TextToolbarItem />
          <MathNoteToolbarItem />
          <AssetToolbarItem />
          <RectangleToolbarItem />
          <EllipseToolbarItem />
          <LineToolbarItem />
          <LaserToolbarItem />
        </DefaultToolbar>
      ),
      HelperButtons: ExitPenModeButton,
      InFrontOfTheCanvas: () => <><DocumentPanel /><PingButton /></>,
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

  const panelContextValue = useMemo(() => ({
    docName: docKey,
    pages: document.pages.map(p => ({
      bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
      width: p.width,
      height: p.height,
      textData: p.textData,
      shapeId: p.shapeId,
    })),
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
    cameraLinked,
    onToggleCameraLink: toggleCameraLink,
    panelsLocal,
    onTogglePanelsLocal: togglePanelsLocal,
    snapshotCount,
    snapshotTimestamps: snapshotCount > 0 ? getSnapshots().map(s => s.timestamp) : undefined,
    activeSnapshotIdx: snapshotSliderIdx,
    onSliderChange: handleSliderChange,
  }), [docKey, document, hasDiffBuiltin, hasDiffToggle, diffMode, diffLoading, toggleDiff, proofMode, proofLoading, proofDataReady, toggleProof, cameraLinked, toggleCameraLink, panelsLocal, togglePanelsLocal, snapshotCount, snapshotSliderIdx, handleSliderChange])

  const shapeUtils = useMemo(() => [MathNoteShapeUtil, HtmlPageShapeUtil, SvgPageShapeUtil], [])
  const tools = useMemo(() => [MathNoteTool, TextSelectTool], [])

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
      return tools
    },
  }), [])

  return (
    <PanelContext.Provider value={panelContextValue}>
    <Tldraw
        licenseKey={LICENSE_KEY}
        shapeUtils={shapeUtils}
        tools={tools}
        overrides={overrides}
        onMount={(editor) => {
          // Expose editor for debugging/puppeteer access
          (window as unknown as { __tldraw_editor__: Editor }).__tldraw_editor__ = editor
          editorRef.current = editor

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

          // Signal that pages are ready — disables Yjs init deletion protection
          window.dispatchEvent(new CustomEvent('tldraw-pages-ready'))

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
                tool,
                diffMode: diffModeRef.current,
                proofMode: proofModeRef.current,
                cameraLinked: cameraLinkedRef.current,
                panelsLocal: panelsLocalRef.current,
              }))
            } catch { /* quota exceeded etc */ }
          }

          function loadSession() {
            try {
              const raw = localStorage.getItem(sessionKey)
              if (!raw) return null
              return JSON.parse(raw) as { camera?: { x: number; y: number; z: number }; tool?: string; diffMode?: boolean; proofMode?: boolean; cameraLinked?: boolean; panelsLocal?: boolean }
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
              if (session?.camera) {
                editor.setCamera(session.camera)
              }
              if (session?.tool) {
                try { editor.setCurrentTool(session.tool) } catch { /* tool may not exist */ }
              }
              // Restore diff mode if it was active
              if (session?.diffMode && hasDiffToggle) {
                toggleDiffRef.current()
              }
              if (session?.proofMode) {
                toggleProofRef.current()
              }
              if (session?.cameraLinked) {
                setCameraLinked(true)
              }
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
                  // Report visible pages to Yjs (for watcher priority rebuild)
                  const yRecords = getYRecords()
                  if (yRecords && document.pages.length > 0) {
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

              // Camera link: broadcast position to other viewers (faster debounce)
              react('broadcast-camera', () => {
                const cam = editor.getCamera() // subscribe
                if (!cameraLinkedRef.current || suppressBroadcastRef.current) return
                if (broadcastTimerRef.current) clearTimeout(broadcastTimerRef.current)
                broadcastTimerRef.current = setTimeout(() => {
                  if (cameraLinkedRef.current && !suppressBroadcastRef.current) {
                    broadcastCamera(cam.x, cam.y, cam.z)
                  }
                }, 30)
              })

              react('save-tool', () => {
                editor.getCurrentToolId() // subscribe
                saveSession()
              })
            }, 500)
          }

          // Keyboard shortcuts
          const handleKeyDown = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) return
            if (isInputFocused()) return
            if (editor.getEditingShapeId()) return

            if (e.key === 'm') {
              editor.setCurrentTool('math-note')
            } else if (e.key === 'd') {
              // Cycle: system → dark → light → system
              const prefs = editor.user.getUserPreferences()
              const scheme = prefs.colorScheme || 'system'
              const next = scheme === 'system' ? 'dark' : scheme === 'dark' ? 'light' : 'system'
              editor.user.updateUserPreferences({ colorScheme: next })
            }
          }
          window.addEventListener('keydown', handleKeyDown)

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
      <YjsSyncProvider roomId={roomId} onInitialSync={() => ensurePagesAtBottomRef.current?.()} />
      <DarkModeSync />
    </Tldraw>
    {bottomPanelsRef.current && createPortal(
      <>
        {panelsLocal && refViewerRefs && editorRef.current && (
          <RefViewer
            mainEditor={editorRef.current}
            pages={panelContextValue.pages}
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
            pages={panelContextValue.pages}
            shapeUtils={shapeUtils}
            tools={tools}
            licenseKey={LICENSE_KEY}
          />
        )}
      </>,
      bottomPanelsRef.current,
    )}
    </PanelContext.Provider>
  )
}
