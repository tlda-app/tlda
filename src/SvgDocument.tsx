import { useMemo, useEffect, useRef, useContext } from 'react'
import {
  Tldraw,
  createShapeId,
  getIndicesBetween,
  react,
  sortByIndex,
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
import type { TLComponents, TLImageShape, TLShapePartial, Editor, TLShape, TLShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import { MathNoteShapeUtil } from './MathNoteShape'
import { MathNoteTool } from './MathNoteTool'
import { TextSelectTool } from './TextSelectTool'
import { useYjsSync, onReloadSignal, onForwardSync, onScreenshotRequest, getYRecords } from './useYjsSync'
import type { ForwardSyncSignal } from './useYjsSync'
import { resolvAnchor, pdfToCanvas, type SourceAnchor } from './synctexAnchor'
import { DocumentPanel, PingButton } from './DocumentPanel'
import { PanelContext } from './PanelContext'
import { TextSelectionLayer, extractTextFromSvgAsync } from './TextSelectionLayer'
import { currentDocumentInfo, setCurrentDocumentInfo, pageSpacing, type SvgDocument, type SvgPage } from './svgDocumentLoader'

// Sync server URL - use env var, or auto-detect based on environment
// In dev mode, use local sync server (works for both localhost and LAN access like 10.0.0.x)
// In production (GitHub Pages), use Fly.io
const SYNC_SERVER = import.meta.env.VITE_SYNC_SERVER ||
  (import.meta.env.DEV
    ? `ws://${window.location.hostname}:5176`
    : 'wss://tldraw-sync-skip.fly.dev')

const LICENSE_KEY = 'tldraw-2027-01-19/WyJhUGMwcWRBayIsWyIqLnF0bTI4NS5naXRodWIuaW8iXSw5LCIyMDI3LTAxLTE5Il0.Hq9z1V8oTLsZKgpB0pI3o/RXCoLOsh5Go7Co53YGqHNmtEO9Lv/iuyBPzwQwlxQoREjwkkFbpflOOPmQMwvQSQ'

// Inner component to set up Yjs sync (needs useEditor context)
function YjsSyncProvider({ roomId }: { roomId: string }) {
  const editor = useEditor()
  useYjsSync({
    editor,
    roomId,
    serverUrl: SYNC_SERVER,
    onInitialSync: () => {
      // Remap annotations after Yjs applies initial data
      if (currentDocumentInfo) {
        remapAnnotations(editor, currentDocumentInfo.name, currentDocumentInfo.pages)
      }
    }
  })
  return null
}

/**
 * Remap annotations with source anchors to their new positions
 * Called after document SVGs are loaded/updated
 */
async function remapAnnotations(
  editor: Editor,
  docName: string,
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number }, width: number, height: number }>
) {
  const allShapes = editor.getCurrentPageShapes()

  // Debug: log all shapes and their meta
  console.log(`[SyncTeX] Total shapes: ${allShapes.length}`)
  console.log(`[SyncTeX] All shapes:`, allShapes.map(s => ({ id: s.id, type: s.type, hasMeta: !!s.meta, metaKeys: Object.keys(s.meta || {}) })))

  // Find shapes with source anchors
  const anchored = allShapes.filter(shape => {
    const meta = shape.meta as { sourceAnchor?: SourceAnchor }
    return meta?.sourceAnchor?.file && meta?.sourceAnchor?.line
  })

  if (anchored.length === 0) {
    console.log('[SyncTeX] No anchored annotations to remap')
    return
  }

  console.log(`[SyncTeX] Remapping ${anchored.length} anchored annotations...`)

  // Resolve each anchor and update position
  const updates: Array<{ id: TLShapeId, x: number, y: number }> = []

  for (const shape of anchored) {
    const meta = shape.meta as unknown as { sourceAnchor: SourceAnchor }
    const anchor = meta.sourceAnchor

    try {
      // Get new PDF position from synctex
      const pdfPos = await resolvAnchor(docName, anchor)
      if (!pdfPos) {
        console.warn(`[SyncTeX] Could not resolve anchor for ${anchor.file}:${anchor.line}`)
        continue
      }

      // Convert to canvas coordinates
      const canvasPos = pdfToCanvas(pdfPos.page, pdfPos.x, pdfPos.y, pages)
      if (!canvasPos) {
        console.warn(`[SyncTeX] Could not convert PDF pos to canvas for page ${pdfPos.page}`)
        continue
      }

      // Only update if position actually changed
      const dx = Math.abs(shape.x - (canvasPos.x - 100))
      const dy = Math.abs(shape.y - (canvasPos.y - 100))
      if (dx > 1 || dy > 1) {
        updates.push({
          id: shape.id,
          x: canvasPos.x - 100, // Offset for note centering (matches MathNoteTool)
          y: canvasPos.y - 100,
        })
        console.log(`[SyncTeX] Moving ${shape.id} to (${canvasPos.x}, ${canvasPos.y}) from ${anchor.file}:${anchor.line}`)
      }
    } catch (e) {
      console.warn(`[SyncTeX] Error resolving anchor:`, e)
    }
  }

  if (updates.length > 0) {
    console.log(`[SyncTeX] Applying ${updates.length} position updates`)
    editor.updateShapes(updates.map(u => ({
      id: u.id,
      type: 'math-note' as const,
      x: u.x,
      y: u.y,
    })) as any)
  }
}

/**
 * Re-fetch SVG pages and hot-swap their TLDraw assets.
 * Called when a reload signal arrives from the MCP server after a rebuild.
 */
async function reloadPages(
  editor: Editor,
  document: SvgDocument,
  pageNumbers: number[] | null, // null = all pages
) {
  // Hot-reload is LaTeX-specific (re-fetch SVGs after rebuild)
  if (document.format === 'png') return

  const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`
  const pages = document.pages
  const indices = pageNumbers
    ? pageNumbers.map(n => n - 1).filter(i => i >= 0 && i < pages.length)
    : pages.map((_, i) => i)

  if (indices.length === 0) return

  console.log(`[Reload] Fetching ${indices.length} page(s): ${indices.map(i => i + 1).join(', ')}`)

  const timestamp = Date.now()

  // Fetch SVGs in parallel with cache-bust
  const results = await Promise.all(
    indices.map(async (i) => {
      const pageNum = String(i + 1).padStart(2, '0')
      const url = `${basePath}page-${pageNum}.svg?t=${timestamp}`
      try {
        const resp = await fetch(url)
        if (!resp.ok) {
          console.warn(`[Reload] Failed to fetch page ${i + 1}: ${resp.status}`)
          return null
        }
        return { index: i, svgText: await resp.text() }
      } catch (e) {
        console.warn(`[Reload] Error fetching page ${i + 1}:`, e)
        return null
      }
    })
  )

  // Process and hot-swap each fetched page
  for (const result of results) {
    if (!result) continue
    const { index, svgText } = result
    const page = pages[index]

    // Re-encode as base64 data URL
    const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)))

    // Update the asset src (this triggers TLDraw to re-render the image)
    const asset = editor.getAsset(page.assetId)
    if (asset && asset.type === 'image') {
      editor.updateAssets([{
        ...asset,
        props: { ...asset.props, src: dataUrl },
      }])
      console.log(`[Reload] Updated asset for page ${index + 1}`)
    }

    // Re-extract text for selection overlay
    const parser = new DOMParser()
    const svgDoc = parser.parseFromString(svgText, 'image/svg+xml')
    page.textData = await extractTextFromSvgAsync(svgDoc)
  }

  // After a full reload, remap annotations
  if (!pageNumbers) {
    if (currentDocumentInfo) {
      await remapAnnotations(editor, currentDocumentInfo.name, currentDocumentInfo.pages)
    }
  }

  console.log(`[Reload] Done — ${indices.length} page(s) updated`)
}

interface SvgDocumentEditorProps {
  document: SvgDocument
  roomId: string
}

// Wrapper to connect TextSelectionLayer to PanelContext
function TextSelectionOverlay() {
  const ctx = useContext(PanelContext)
  if (!ctx) return null
  return <TextSelectionLayer pages={ctx.pages} />
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

export function SvgDocumentEditor({ document, roomId }: SvgDocumentEditorProps) {
  // Skip sync for now - just use local store
  const editorRef = useRef<Editor | null>(null)

  // Subscribe to Yjs reload signals
  useEffect(() => {
    return onReloadSignal((signal) => {
      const editor = editorRef.current
      if (!editor) return
      if (signal.type === 'partial') {
        reloadPages(editor, document, signal.pages)
      } else {
        reloadPages(editor, document, null)
      }
    })
  }, [document])

  // Subscribe to Yjs forward sync signals (scroll, highlight from Claude)
  useEffect(() => {
    return onForwardSync((signal: ForwardSyncSignal) => {
      const editor = editorRef.current
      if (!editor) return

      // Find horizontal center of page containing a canvas y coordinate
      function pageCenterX(canvasY: number): number {
        for (const page of document.pages) {
          if (canvasY >= page.bounds.y && canvasY <= page.bounds.y + page.bounds.h) {
            return page.bounds.x + page.bounds.w / 2
          }
        }
        return document.pages.length > 0
          ? document.pages[0].bounds.x + document.pages[0].bounds.w / 2
          : 400
      }

      if (signal.type === 'scroll') {
        editor.centerOnPoint({ x: pageCenterX(signal.y), y: signal.y }, { animation: { duration: 300 } })
      }

      if (signal.type === 'highlight') {
        editor.centerOnPoint({ x: pageCenterX(signal.y), y: signal.y }, { animation: { duration: 300 } })
        const markerId = createShapeId()
        editor.createShape({
          id: markerId,
          type: 'geo',
          x: signal.x - 30,
          y: signal.y - 30,
          props: { geo: 'ellipse', w: 60, h: 60, fill: 'none', color: 'red', size: 'm' },
        })
        setTimeout(() => {
          if (editor.getShape(markerId)) editor.deleteShape(markerId)
        }, 3000)
      }
    })
  }, [document])

  // Handle screenshot requests from MCP
  useEffect(() => {
    return onScreenshotRequest(async () => {
      const editor = editorRef.current
      const yRecords = getYRecords()
      if (!editor || !yRecords) return
      try {
        const viewportBounds = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: viewportBounds,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const buf = await blob.arrayBuffer()
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1])
          }
          reader.readAsDataURL(new Blob([buf], { type: 'image/png' }))
        })
        const ydoc = yRecords.doc!
        ydoc.transact(() => {
          yRecords.set('signal:screenshot' as any, {
            data: base64,
            mimeType: 'image/png',
            timestamp: Date.now(),
          } as any)
        })
        console.log(`[Screenshot] Captured ${Math.round(base64.length / 1024)}KB`)
      } catch (e) {
        console.warn('[Screenshot] Capture failed:', e)
      }
    })
  }, [])

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
      InFrontOfTheCanvas: () => <><TextSelectionOverlay /><DocumentPanel /><PingButton /></>,
    }),
    [document, roomId]
  )

  const docKey = new URLSearchParams(window.location.search).get('doc') || document.name
  const panelContextValue = useMemo(() => ({
    docName: docKey,
    pages: document.pages.map(p => ({
      bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
      width: p.width,
      height: p.height,
      textData: p.textData,
    })),
  }), [docKey, document])

  const shapeUtils = useMemo(() => [MathNoteShapeUtil], [])
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
          setupSvgEditor(editor, document)

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

          // --- Session persistence ---
          const sessionKey = `tldraw-session:${roomId}`

          function saveSession() {
            try {
              const cam = editor.getCamera()
              const tool = editor.getCurrentToolId()
              localStorage.setItem(sessionKey, JSON.stringify({
                camera: { x: cam.x, y: cam.y, z: cam.z },
                tool,
              }))
            } catch { /* quota exceeded etc */ }
          }

          function loadSession() {
            try {
              const raw = localStorage.getItem(sessionKey)
              if (!raw) return null
              return JSON.parse(raw) as { camera?: { x: number; y: number; z: number }; tool?: string }
            } catch { return null }
          }

          // Restore session after constraints and Yjs sync settle,
          // then start watching for changes
          const session = loadSession()
          setTimeout(() => {
            if (session?.camera) {
              editor.setCamera(session.camera)
            }
            if (session?.tool) {
              try { editor.setCurrentTool(session.tool) } catch { /* tool may not exist */ }
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
                  yRecords.set('signal:viewport' as any, { pages, timestamp: Date.now() } as any)
                }
              }, 500)
            })

            react('save-tool', () => {
              editor.getCurrentToolId() // subscribe
              saveSession()
            })
          }, 500)

          // Keyboard shortcut: 'm' for math note
          const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey) {
              if (editor.getEditingShapeId()) return // Don't trigger while editing
              editor.setCurrentTool('math-note')
            }
          }
          window.addEventListener('keydown', handleKeyDown)

          // Pen double-tap in right edge (panel zone) to cycle draw → highlight → eraser
          const penCycle = ['draw', 'highlight', 'eraser']
          let lastPenTap = 0
          const container = window.document.querySelector('.tl-container') as HTMLElement | null
          if (container) {
            container.addEventListener('pointerdown', (e: PointerEvent) => {
              if (e.pointerType !== 'pen') return
              // Only in the rightmost 250px (doc panel x-span)
              const threshold = window.innerWidth - 250
              if (e.clientX < threshold) {
                lastPenTap = 0
                return
              }
              const now = Date.now()
              if (now - lastPenTap < 300) {
                const current = editor.getCurrentToolId()
                const idx = penCycle.indexOf(current)
                const next = penCycle[(idx + 1) % penCycle.length]
                editor.setCurrentTool(next)
                lastPenTap = 0
              } else {
                lastPenTap = now
              }
            }, true)
          }
        }}
        components={components}
        forceMobile
    >
      <YjsSyncProvider roomId={roomId} />
    </Tldraw>
    </PanelContext.Provider>
  )
}

function setupSvgEditor(editor: Editor, document: SvgDocument) {
  // Check if assets already exist (from sync)
  const existingAssets = editor.getAssets()
  const hasAssets = existingAssets.some(a => a.props && 'name' in a.props && a.props.name === 'svg-page')

  if (!hasAssets) {
    // Create assets for each page
    const mimeType = document.format === 'png' ? 'image/png' : 'image/svg+xml'
    editor.createAssets(
      document.pages.map((page) => ({
        id: page.assetId,
        typeName: 'asset',
        type: 'image',
        meta: {},
        props: {
          w: page.width,
          h: page.height,
          mimeType,
          src: page.src,
          name: 'svg-page',
          isAnimated: false,
        },
      }))
    )

    // Create shapes for each page
    editor.createShapes(
      document.pages.map(
        (page): TLShapePartial<TLImageShape> => ({
          id: page.shapeId,
          type: 'image',
          x: page.bounds.x,
          y: page.bounds.y,
          isLocked: true,
          props: {
            assetId: page.assetId,
            w: page.bounds.w,
            h: page.bounds.h,
          },
        })
      )
    )
  }

  const shapeIds = document.pages.map((page) => page.shapeId)
  const shapeIdSet = new Set(shapeIds)

  // Don't let the user unlock the pages
  editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next) => {
    if (!shapeIdSet.has(next.id)) return next
    if (next.isLocked) return next
    return { ...prev, isLocked: true }
  })

  // Make sure the shapes are below any of the other shapes
  function makeSureShapesAreAtBottom() {
    const shapes = shapeIds
      .map((id) => editor.getShape(id))
      .filter((s): s is TLShape => s !== undefined)
      .sort(sortByIndex)
    if (shapes.length === 0) return

    const pageId = editor.getCurrentPageId()
    const siblings = editor.getSortedChildIdsForParent(pageId)
    const currentBottomShapes = siblings
      .slice(0, shapes.length)
      .map((id) => editor.getShape(id)!)

    if (currentBottomShapes.every((shape, i) => shape?.id === shapes[i]?.id)) return

    const otherSiblings = siblings.filter((id) => !shapeIdSet.has(id))
    if (otherSiblings.length === 0) return

    const bottomSibling = otherSiblings[0]
    const bottomShape = editor.getShape(bottomSibling)
    if (!bottomShape) return

    const lowestIndex = bottomShape.index
    const indexes = getIndicesBetween(undefined, lowestIndex, shapes.length)

    editor.updateShapes(
      shapes.map((shape, i) => ({
        id: shape.id,
        type: shape.type,
        isLocked: true,
        index: indexes[i],
      }))
    )
  }

  makeSureShapesAreAtBottom()
  editor.sideEffects.registerAfterCreateHandler('shape', makeSureShapesAreAtBottom)
  editor.sideEffects.registerAfterChangeHandler('shape', makeSureShapesAreAtBottom)

  // Constrain the camera to the bounds of the pages
  const targetBounds = document.pages.reduce(
    (acc, page) => acc.union(page.bounds),
    document.pages[0].bounds.clone()
  )

  function updateCameraBounds(_isMobile: boolean) {
    editor.setCameraOptions({
      constraints: {
        bounds: targetBounds,
        padding: { x: 100, y: 50 },
        origin: { x: 0.5, y: 0 },
        initialZoom: 'fit-x-100',
        baseZoom: 'default',
        behavior: 'free',
      },
    })
    editor.setCamera(editor.getCamera(), { reset: true })
  }

  let isMobile = editor.getViewportScreenBounds().width < 840

  react('update camera', () => {
    const isMobileNow = editor.getViewportScreenBounds().width < 840
    if (isMobileNow === isMobile) return
    isMobile = isMobileNow
    updateCameraBounds(isMobile)
  })

  updateCameraBounds(isMobile)
}

