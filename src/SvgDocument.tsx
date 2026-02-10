import { useMemo, useEffect, useRef, useContext, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
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
  toRichText,
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
import { HtmlPageShapeUtil } from './HtmlPageShape'
import { MathNoteTool } from './MathNoteTool'
import { TextSelectTool } from './TextSelectTool'
import { useYjsSync, onReloadSignal, onForwardSync, onScreenshotRequest, getYRecords } from './useYjsSync'
import type { ForwardSyncSignal } from './useYjsSync'
import { resolvAnchor, pdfToCanvas, type SourceAnchor } from './synctexAnchor'
import { clearLookupCache, buildReverseIndex } from './synctexLookup'
import { DocumentPanel, PingButton } from './DocumentPanel'
import { PanelContext } from './PanelContext'
import { TextSelectionLayer, extractTextFromSvgAsync } from './TextSelectionLayer'
import { currentDocumentInfo, setCurrentDocumentInfo, pageSpacing, loadDiffData, loadProofData, type SvgDocument, type SvgPage, type DiffData, type DiffHighlight, type ProofData, type LabelRegion } from './svgDocumentLoader'
import { ProofStatementOverlay } from './ProofStatementOverlay'
import { RefViewer } from './RefViewer'
import { canvasToPdf } from './synctexAnchor'

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
  if (document.format === 'png' || document.format === 'diff') return

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
  diffConfig?: { basePath: string }
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

export function SvgDocumentEditor({ document, roomId, diffConfig }: SvgDocumentEditorProps) {
  const editorRef = useRef<Editor | null>(null)

  // --- Diff toggle state ---
  const hasDiffBuiltin = !!document.diffLayout  // standalone diff doc
  const hasDiffToggle = !hasDiffBuiltin && !!diffConfig  // normal doc with diff available
  const [diffMode, setDiffMode] = useState(false)
  const diffDataRef = useRef<DiffData | null>(null)
  const diffShapeIdsRef = useRef<Set<TLShapeId>>(new Set())
  const diffEffectCleanupRef = useRef<(() => void) | null>(null)
  const diffLoadingRef = useRef(false)
  const [diffLoading, setDiffLoading] = useState(false)
  const diffModeRef = useRef(false)
  const toggleDiffRef = useRef<() => void>(() => {})
  const [diffFetchSeq, setDiffFetchSeq] = useState(0)  // bumped on reload to re-trigger pre-fetch
  const sessionRestoredRef = useRef(false)
  // --- Proof reader toggle state ---
  const [proofMode, setProofMode] = useState(false)
  const proofDataRef = useRef<ProofData | null>(null)
  const proofShapeIdsRef = useRef<Set<TLShapeId>>(new Set())
  const proofLoadingRef = useRef(false)
  const [proofLoading, setProofLoading] = useState(false)
  const proofModeRef = useRef(false)
  const toggleProofRef = useRef<() => void>(() => {})
  const [proofFetchSeq, setProofFetchSeq] = useState(0)
  const [proofDataReady, setProofDataReady] = useState(false)

  // --- Ref viewer state (click-to-reference) ---
  const [refViewerRefs, setRefViewerRefs] = useState<{ label: string; region: LabelRegion }[] | null>(null)
  const refViewerLineRef = useRef<number | null>(null)  // current source line shown in ref viewer
  const sortedRefLinesRef = useRef<number[]>([])  // all lines with refs, sorted

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

  // Refs for setupSvgEditor's mutable sets — populated in onMount
  const shapeIdSetRef = useRef<Set<TLShapeId>>(new Set())
  const shapeIdsArrayRef = useRef<TLShapeId[]>([])
  const updateCameraBoundsRef = useRef<((bounds: any) => void) | null>(null)

  // Pulse highlight boxes when navigating to a change (works for both standalone diff and toggle)
  const focusChangeRef = useRef<((currentPage: number) => void) | null>(null)

  // Keep refs in sync with state for access in closures
  useEffect(() => { diffModeRef.current = diffMode }, [diffMode])
  useEffect(() => { proofModeRef.current = proofMode }, [proofMode])

  const toggleDiff = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || !diffConfig || diffLoadingRef.current) return

    if (!diffMode) {
      // Turning ON
      if (!diffDataRef.current) {
        diffLoadingRef.current = true
        setDiffLoading(true)
        try {
          diffDataRef.current = await loadDiffData(document.name, diffConfig.basePath, document.pages)
        } catch (e) {
          console.error('[Diff Toggle] Failed to load diff data:', e)
          diffLoadingRef.current = false
          setDiffLoading(false)
          return
        }
        diffLoadingRef.current = false
        setDiffLoading(false)
      }

      const dd = diffDataRef.current
      const createdIds = new Set<TLShapeId>()

      // Create overlay shapes as local-only (mergeRemoteChanges → source:'remote' → skipped by Yjs sync)
      // Using editor.createAssets/createShapes inside mergeRemoteChanges so defaults are filled in
      // (store.put bypasses default-filling and fails validation for missing props like 'playing')
      editor.store.mergeRemoteChanges(() => {
        // Create old page assets + shapes
        const mimeType = 'image/svg+xml'
        editor.createAssets(
          dd.pages.map(oldPage => ({
            id: oldPage.assetId,
            typeName: 'asset' as const,
            type: 'image' as const,
            meta: {},
            props: {
              w: oldPage.width,
              h: oldPage.height,
              mimeType,
              src: oldPage.src,
              name: 'diff-old-page',
              isAnimated: false,
            },
          }))
        )

        // Old page image shapes
        editor.createShapes(
          dd.pages.map((oldPage): TLShapePartial<TLImageShape> => ({
            id: oldPage.shapeId,
            type: 'image',
            x: oldPage.bounds.x,
            y: oldPage.bounds.y,
            isLocked: true,
            opacity: 0.5,
            props: {
              assetId: oldPage.assetId,
              w: oldPage.bounds.w,
              h: oldPage.bounds.h,
            },
          }))
        )
        for (const oldPage of dd.pages) {
          createdIds.add(oldPage.shapeId)
        }

        // Labels above old pages
        const labelShapes: any[] = []
        for (const oldPage of dd.pages) {
          const match = (oldPage.shapeId as string).match(/old-page-(\d+)/)
          if (!match) continue
          const labelId = createShapeId(`${document.name}-old-label-${match[1]}`)
          labelShapes.push({
            id: labelId,
            type: 'text',
            x: oldPage.bounds.x,
            y: oldPage.bounds.y - 26,
            isLocked: true,
            opacity: 0.3,
            props: {
              richText: toRichText(`Old p.${match[1]}`),
              font: 'sans',
              size: 's',
              color: 'grey',
              scale: 0.8,
            },
          })
          createdIds.add(labelId)
        }
        if (labelShapes.length > 0) editor.createShapes(labelShapes)

        // Highlight rectangles
        editor.createShapes(
          dd.highlights.map((hl, i) => {
            const hlId = createShapeId(`${document.name}-diff-hl-${i}`)
            createdIds.add(hlId)
            return {
              id: hlId,
              type: 'geo' as const,
              x: hl.x,
              y: hl.y,
              isLocked: true,
              opacity: 0.07,
              props: {
                geo: 'rectangle',
                w: hl.w,
                h: hl.h,
                fill: 'solid',
                color: hl.side === 'current' ? 'light-blue' : 'light-red',
                dash: 'draw',
                size: 's',
              },
            }
          })
        )

        // Arrows
        editor.createShapes(
          dd.arrows.map((a, i) => {
            const arrowId = createShapeId(`${document.name}-diff-arrow-${i}`)
            createdIds.add(arrowId)
            return {
              id: arrowId,
              type: 'arrow' as const,
              x: a.startX,
              y: a.startY,
              isLocked: true,
              opacity: 0.2,
              props: {
                color: 'grey',
                size: 's',
                dash: 'solid',
                start: { x: 0, y: 0 },
                end: { x: a.endX - a.startX, y: a.endY - a.startY },
                arrowheadStart: 'none',
                arrowheadEnd: 'arrow',
              },
            }
          })
        )
      })

      // Track created IDs
      diffShapeIdsRef.current = createdIds
      // Add to the lock-prevention set
      for (const id of createdIds) {
        shapeIdSetRef.current.add(id)
        shapeIdsArrayRef.current.push(id)
      }

      // Set up hover + review effects
      const hoverCleanup = setupDiffHoverEffectFromData(editor, document.name, dd)
      const reviewCleanup = setupDiffReviewEffectFromData(editor, document.name, dd)
      diffEffectCleanupRef.current = () => { hoverCleanup(); reviewCleanup() }

      // Set up pulse effect for this diff data
      setupPulseForDiffData(editor, document.name, dd, focusChangeRef)

      // Expand camera bounds to include old diff pages
      if (updateCameraBoundsRef.current && dd.pages.length > 0) {
        const allBounds = document.pages.reduce(
          (acc, page) => acc.union(page.bounds),
          document.pages[0].bounds.clone()
        )
        for (const oldPage of dd.pages) {
          allBounds.union(oldPage.bounds)
        }
        updateCameraBoundsRef.current(allBounds)
      }

      setDiffMode(true)
      console.log(`[Diff Toggle] ON — ${createdIds.size} overlay shapes created`)
    } else {
      // Turning OFF
      diffEffectCleanupRef.current?.()
      diffEffectCleanupRef.current = null
      focusChangeRef.current = null

      const idsToRemove = diffShapeIdsRef.current
      if (idsToRemove.size > 0) {
        // Also collect asset IDs for old pages
        const assetIds = diffDataRef.current?.pages.map(p => p.assetId) || []

        editor.store.mergeRemoteChanges(() => {
          const allIds = [...idsToRemove, ...assetIds] as any[]
          editor.store.remove(allIds)
        })

        // Remove from lock-prevention set
        for (const id of idsToRemove) {
          shapeIdSetRef.current.delete(id)
        }
        shapeIdsArrayRef.current = shapeIdsArrayRef.current.filter(id => !idsToRemove.has(id))
      }
      diffShapeIdsRef.current = new Set()

      // Contract camera bounds back to current pages only
      if (updateCameraBoundsRef.current) {
        const currentBounds = document.pages.reduce(
          (acc, page) => acc.union(page.bounds),
          document.pages[0].bounds.clone()
        )
        updateCameraBoundsRef.current(currentBounds)
      }

      setDiffMode(false)
      console.log('[Diff Toggle] OFF — overlay shapes removed')
    }
  }, [diffMode, diffConfig, document])

  // Keep toggleDiff ref current for session restore
  useEffect(() => { toggleDiffRef.current = toggleDiff }, [toggleDiff])

  // --- Proof reader toggle ---
  const hasProofInfo = !!document.basePath  // any doc with basePath could have proof-info.json

  const toggleProof = useCallback(async () => {
    const editor = editorRef.current
    if (!editor || proofLoadingRef.current) return

    const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`

    if (!proofMode) {
      // Turning ON
      if (!proofDataRef.current) {
        proofLoadingRef.current = true
        setProofLoading(true)
        try {
          proofDataRef.current = await loadProofData(document.name, basePath, document.pages)
        } catch (e) {
          console.error('[Proof Toggle] Failed to load proof data:', e)
          proofLoadingRef.current = false
          setProofLoading(false)
          return
        }
        proofLoadingRef.current = false
        setProofLoading(false)
      }

      const pd = proofDataRef.current
      if (pd.highlights.length === 0) {
        console.log('[Proof Toggle] No cross-page pairs found')
        return
      }

      const createdIds = new Set<TLShapeId>()

      // Create only highlight shapes — statement display is handled by the overlay
      editor.store.mergeRemoteChanges(() => {
        editor.createShapes(
          pd.highlights.map((hl, i) => {
            const hlId = createShapeId(`${document.name}-proof-hl-${i}`)
            createdIds.add(hlId)
            return {
              id: hlId,
              type: 'geo' as const,
              x: hl.x,
              y: hl.y,
              isLocked: true,
              opacity: 0,
              props: {
                geo: 'rectangle',
                w: hl.w,
                h: hl.h,
                fill: 'solid',
                color: 'light-green',
                dash: 'draw',
                size: 's',
              },
            }
          })
        )
      })

      proofShapeIdsRef.current = createdIds
      for (const id of createdIds) {
        shapeIdSetRef.current.add(id)
        shapeIdsArrayRef.current.push(id)
      }

      setProofMode(true)
      console.log(`[Proof Toggle] ON — ${createdIds.size} highlight shapes, overlay active`)
    } else {
      // Turning OFF
      const idsToRemove = proofShapeIdsRef.current
      if (idsToRemove.size > 0) {
        editor.store.mergeRemoteChanges(() => {
          editor.store.remove([...idsToRemove] as any[])
        })
        for (const id of idsToRemove) {
          shapeIdSetRef.current.delete(id)
        }
        shapeIdsArrayRef.current = shapeIdsArrayRef.current.filter(id => !idsToRemove.has(id))
      }
      proofShapeIdsRef.current = new Set()

      setProofMode(false)
      console.log('[Proof Toggle] OFF — highlights removed, overlay dismissed')
    }
  }, [proofMode, document])

  useEffect(() => { toggleProofRef.current = toggleProof }, [toggleProof])

  // Subscribe to Yjs reload signals
  useEffect(() => {
    return onReloadSignal((signal) => {
      const editor = editorRef.current
      if (!editor) return
      if (signal.type === 'partial') {
        reloadPages(editor, document, signal.pages)
      } else {
        clearLookupCache(document.name)
        diffDataRef.current = null  // invalidate so next toggle re-fetches
        setDiffFetchSeq(s => s + 1)  // re-trigger pre-fetch
        proofDataRef.current = null  // invalidate proof data too
        setProofDataReady(false)
        setProofFetchSeq(s => s + 1)
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

  // Guard: skip keyboard shortcuts when a DOM input/textarea has focus
  function isInputFocused() {
    const tag = window.document.activeElement?.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || (window.document.activeElement as HTMLElement)?.isContentEditable
  }

  // Pre-fetch diff data in background for instant first toggle
  // Re-runs when diffFetchSeq bumps (after reload invalidation)
  useEffect(() => {
    if (!diffConfig) return
    loadDiffData(document.name, diffConfig.basePath, document.pages)
      .then(data => { if (!diffDataRef.current) diffDataRef.current = data })
      .catch(e => console.warn('[Diff] Pre-fetch failed:', e))
  }, [diffConfig, document, diffFetchSeq])

  // Pre-fetch proof data in background for instant first toggle
  useEffect(() => {
    if (!hasProofInfo) return
    setProofDataReady(false)
    const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`
    loadProofData(document.name, basePath, document.pages)
      .then(data => {
        if (!proofDataRef.current) proofDataRef.current = data
        setProofDataReady(true)
      })
      .catch(() => {}) // proof-info.json may not exist — that's fine
  }, [hasProofInfo, document, proofFetchSeq])

  // --- Click-to-ref: double-click on document text to look up references ---
  const reverseIndexRef = useRef<((page: number, y: number) => number | null) | null>(null)
  useEffect(() => {
    buildReverseIndex(document.name).then(fn => { reverseIndexRef.current = fn })
  }, [document.name])

  // Helper: resolve refs on a given line to regions
  const resolveRefsOnLine = useCallback((line: number): { label: string; region: LabelRegion }[] | null => {
    const proofData = proofDataRef.current
    if (!proofData) return null
    const lineRefsMap = proofData.lineRefs
    // Check exact line and nearby (synctex can be off by a few lines)
    let refsOnLine: string[] | undefined
    let matchedLine = line
    for (let offset = 0; offset <= 5; offset++) {
      if (lineRefsMap[(line + offset).toString()]) {
        refsOnLine = lineRefsMap[(line + offset).toString()]
        matchedLine = line + offset
        break
      }
      if (offset > 0 && lineRefsMap[(line - offset).toString()]) {
        refsOnLine = lineRefsMap[(line - offset).toString()]
        matchedLine = line - offset
        break
      }
    }
    if (!refsOnLine || refsOnLine.length === 0) return null
    const resolved: { label: string; region: LabelRegion }[] = []
    for (const label of refsOnLine) {
      const region = proofData.labelRegions[label]
      if (region) resolved.push({ label, region })
    }
    if (resolved.length === 0) return null
    refViewerLineRef.current = matchedLine
    return resolved
  }, [])

  // Build sorted ref lines when proof data loads
  useEffect(() => {
    const proofData = proofDataRef.current
    if (!proofData || !proofDataReady) {
      sortedRefLinesRef.current = []
      return
    }
    sortedRefLinesRef.current = Object.keys(proofData.lineRefs).map(Number).sort((a, b) => a - b)
  }, [proofDataReady])

  // Navigate to prev/next ref line
  const navigateRefLine = useCallback((direction: -1 | 1) => {
    const currentLine = refViewerLineRef.current
    if (currentLine === null) return
    const sorted = sortedRefLinesRef.current
    const idx = sorted.indexOf(currentLine)
    if (idx < 0) return
    const nextIdx = idx + direction
    if (nextIdx < 0 || nextIdx >= sorted.length) return
    const nextLine = sorted[nextIdx]
    const resolved = resolveRefsOnLine(nextLine)
    if (resolved) setRefViewerRefs(resolved)
  }, [resolveRefsOnLine])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !proofDataReady) return

    const handleDoubleClick = (e: MouseEvent) => {
      const reverseIndex = reverseIndexRef.current
      if (!reverseIndex) return

      // Convert screen point to canvas coords
      const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
      // Convert canvas coords to PDF coords (page + y)
      const pages = document.pages.map(p => ({
        bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
        width: p.width,
        height: p.height,
      }))
      const pdf = canvasToPdf(point.x, point.y, pages)
      if (!pdf) return

      // Reverse lookup: PDF coords → source line
      const line = reverseIndex(pdf.page, pdf.y)
      if (!line) return

      const resolved = resolveRefsOnLine(line)
      if (resolved) setRefViewerRefs(resolved)
    }

    // Use native dblclick on the TLDraw container
    const container = editor.getContainer()
    container.addEventListener('dblclick', handleDoubleClick)
    return () => container.removeEventListener('dblclick', handleDoubleClick)
  }, [document, proofDataReady, resolveRefsOnLine])

  // Keyboard shortcut: 'd' for diff toggle
  useEffect(() => {
    if (!hasDiffToggle) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isInputFocused()) return
        const editor = editorRef.current
        if (!editor) return
        if (editor.getEditingShapeId()) return
        toggleDiff()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [hasDiffToggle, toggleDiff])

  // Keyboard shortcut: 'r' for proof reader toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isInputFocused()) return
        const editor = editorRef.current
        if (!editor) return
        if (editor.getEditingShapeId()) return
        toggleProof()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleProof])

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
      InFrontOfTheCanvas: () => <><TextSelectionOverlay /><DocumentPanel /><PingButton /></>,
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
  }), [docKey, document, hasDiffBuiltin, hasDiffToggle, diffMode, diffLoading, toggleDiff, proofMode, proofLoading, proofDataReady, toggleProof])

  const shapeUtils = useMemo(() => [MathNoteShapeUtil, HtmlPageShapeUtil], [])
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
          const editorSetup = setupSvgEditor(editor, document)
          shapeIdSetRef.current = editorSetup.shapeIdSet
          shapeIdsArrayRef.current = editorSetup.shapeIds
          updateCameraBoundsRef.current = editorSetup.updateBounds

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
                diffMode: diffModeRef.current,
                proofMode: proofModeRef.current,
              }))
            } catch { /* quota exceeded etc */ }
          }

          function loadSession() {
            try {
              const raw = localStorage.getItem(sessionKey)
              if (!raw) return null
              return JSON.parse(raw) as { camera?: { x: number; y: number; z: number }; tool?: string; diffMode?: boolean; proofMode?: boolean }
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
          }

          // Keyboard shortcut: 'm' for math note
          const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'm' && !e.metaKey && !e.ctrlKey && !e.altKey) {
              if (isInputFocused()) return
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
    {bottomPanelsRef.current && createPortal(
      <>
        {refViewerRefs && editorRef.current && (
          <RefViewer
            mainEditor={editorRef.current}
            pages={panelContextValue.pages}
            refs={refViewerRefs}
            shapeUtils={shapeUtils}
            tools={tools}
            licenseKey={LICENSE_KEY}
            onClose={() => { setRefViewerRefs(null); refViewerLineRef.current = null }}
            onPrevLine={() => navigateRefLine(-1)}
            onNextLine={() => navigateRefLine(1)}
            onJump={(region) => {
              const editor = editorRef.current
              if (!editor) return
              const pageIdx = region.page - 1
              const page = document.pages[pageIdx]
              if (!page) return
              const scaleY = page.bounds.height / 792
              const canvasY = page.bounds.y + region.yTop * scaleY
              editor.centerOnPoint(
                { x: page.bounds.x + page.bounds.width / 2, y: canvasY },
                { animation: { duration: 300 } }
              )
            }}
          />
        )}
        {proofMode && editorRef.current && proofDataRef.current && (
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

/**
 * Create diff overlay shapes: old page opacity styling, labels, and highlight rectangles.
 * Adds created shape IDs to extraShapeIds so they get locked/bottom-sorted with page shapes.
 */
function setupDiffOverlays(editor: Editor, document: SvgDocument, extraShapeIds: TLShapeId[]) {
  const diff = document.diffLayout!

  // Create labels above old pages
  for (const idx of diff.oldPageIndices) {
    const page = document.pages[idx]
    if (!page) continue
    const match = page.shapeId.match(/old-page-(\d+)/)
    if (!match) continue
    const oldPageNum = match[1]
    const labelId = createShapeId(`${document.name}-old-label-${oldPageNum}`)
    editor.createShapes([{
      id: labelId,
      type: 'text',
      x: page.bounds.x,
      y: page.bounds.y - 26,
      isLocked: true,
      opacity: 0.3,
      props: {
        richText: toRichText(`Old p.${oldPageNum}`),
        font: 'sans',
        size: 's',
        color: 'grey',
        scale: 0.8,
      },
    }])
    extraShapeIds.push(labelId)
  }

  // Create highlight overlay rectangles
  for (let i = 0; i < diff.highlights.length; i++) {
    const hl = diff.highlights[i]
    const hlId = createShapeId(`${document.name}-diff-hl-${i}`)
    editor.createShapes([{
      id: hlId,
      type: 'geo',
      x: hl.x,
      y: hl.y,
      isLocked: true,
      opacity: 0.07,
      props: {
        geo: 'rectangle',
        w: hl.w,
        h: hl.h,
        fill: 'solid',
        color: hl.side === 'current' ? 'light-blue' : 'light-red',
        dash: 'draw',
        size: 's',
      },
    }])
    extraShapeIds.push(hlId)
  }

  // Create connector arrows between corresponding highlight boxes
  for (let i = 0; i < diff.arrows.length; i++) {
    const a = diff.arrows[i]
    const arrowId = createShapeId(`${document.name}-diff-arrow-${i}`)

    editor.createShapes([{
      id: arrowId,
      type: 'arrow',
      x: a.startX,
      y: a.startY,
      isLocked: true,
      opacity: 0.2,
      props: {
        color: 'grey',
        size: 's',
        dash: 'solid',
        start: { x: 0, y: 0 },
        end: { x: a.endX - a.startX, y: a.endY - a.startY },
        arrowheadStart: 'none',
        arrowheadEnd: 'arrow',
      },
    }])
    extraShapeIds.push(arrowId)
  }

  console.log(`[Diff] Created ${diff.highlights.length} highlights, ${diff.arrows.length} arrows for ${diff.oldPageIndices.size} old pages`)
}

/**
 * Set up hover effect: arrows become more visible when pointer is over a connected highlight box.
 * Works regardless of whether shapes were just created or came from Yjs sync.
 */
function setupDiffHoverEffect(editor: Editor, document: SvgDocument) {
  setupDiffHoverEffectFromData(editor, document.name, {
    highlights: document.diffLayout!.highlights,
    arrows: document.diffLayout!.arrows,
  } as DiffData)
}

/**
 * Hover effect that works with DiffData directly. Returns cleanup function.
 */
function setupDiffHoverEffectFromData(
  editor: Editor,
  docName: string,
  dd: Pick<DiffData, 'highlights' | 'arrows'>,
): () => void {
  const highlightShapeIds = dd.highlights.map((_, i) =>
    createShapeId(`${docName}-diff-hl-${i}`)
  )
  const arrowShapeIds = dd.arrows.map((_, i) =>
    createShapeId(`${docName}-diff-arrow-${i}`)
  )

  const highlightToArrows = new Map<TLShapeId, TLShapeId[]>()
  for (let i = 0; i < dd.arrows.length; i++) {
    const a = dd.arrows[i]
    const arrowId = arrowShapeIds[i]
    for (const hlId of [highlightShapeIds[a.oldHighlightIdx], highlightShapeIds[a.currentHighlightIdx]]) {
      if (!hlId) continue
      if (!highlightToArrows.has(hlId)) highlightToArrows.set(hlId, [])
      highlightToArrows.get(hlId)!.push(arrowId)
    }
  }

  let activeArrowIds = new Set<TLShapeId>()

  const handlePointerMove = (e: PointerEvent) => {
    const point = editor.screenToPage({ x: e.clientX, y: e.clientY })

    let hoveredHlId: TLShapeId | null = null
    for (const hlId of highlightShapeIds) {
      const bounds = editor.getShapePageBounds(hlId)
      if (bounds && bounds.containsPoint(point)) {
        hoveredHlId = hlId
        break
      }
    }

    const newActive = new Set<TLShapeId>(
      hoveredHlId ? (highlightToArrows.get(hoveredHlId) || []) : []
    )

    if (newActive.size === activeArrowIds.size &&
        [...newActive].every(id => activeArrowIds.has(id))) return

    const updates: Array<{ id: TLShapeId; type: 'arrow'; opacity: number }> = []
    for (const aid of activeArrowIds) {
      if (!newActive.has(aid)) updates.push({ id: aid, type: 'arrow', opacity: 0.2 })
    }
    for (const aid of newActive) {
      if (!activeArrowIds.has(aid)) updates.push({ id: aid, type: 'arrow', opacity: 0.6 })
    }

    if (updates.length > 0) editor.updateShapes(updates)
    activeArrowIds = newActive
  }

  const container = window.document.querySelector('.tl-container')
  if (container) {
    container.addEventListener('pointermove', handlePointerMove as EventListener)
  }

  return () => {
    if (container) {
      container.removeEventListener('pointermove', handlePointerMove as EventListener)
    }
  }
}

/**
 * Watch Yjs review state and adjust highlight box opacity.
 * Chosen side becomes more opaque, rejected side fades.
 */
function setupDiffReviewEffect(editor: Editor, document: SvgDocument) {
  setupDiffReviewEffectFromData(editor, document.name, {
    highlights: document.diffLayout!.highlights,
  } as DiffData)
}

/**
 * Review effect that works with DiffData directly. Returns cleanup function.
 */
function setupDiffReviewEffectFromData(
  editor: Editor,
  docName: string,
  dd: Pick<DiffData, 'highlights'>,
): () => void {
  const yRecords = getYRecords()
  if (!yRecords) return () => {}

  const pageHighlights = new Map<number, { current: TLShapeId[], old: TLShapeId[] }>()
  for (let i = 0; i < dd.highlights.length; i++) {
    const hl = dd.highlights[i]
    const hlId = createShapeId(`${docName}-diff-hl-${i}`)
    if (!pageHighlights.has(hl.currentPage)) {
      pageHighlights.set(hl.currentPage, { current: [], old: [] })
    }
    pageHighlights.get(hl.currentPage)![hl.side === 'current' ? 'current' : 'old'].push(hlId)
  }

  const BASE_OPACITY = 0.07
  const CHOSEN_OPACITY = 0.15
  const REJECTED_OPACITY = 0.03

  let lastReviews: Record<number, string> = {}

  function applyReviewState() {
    const signal = yRecords!.get('signal:diff-review' as any) as any
    const reviews: Record<number, string> = signal?.reviews || {}

    const updates: Array<{ id: TLShapeId; type: 'geo'; opacity: number }> = []

    for (const [page, { current, old }] of pageHighlights) {
      const status = reviews[page] || null
      const prevStatus = lastReviews[page] || null
      if (status === prevStatus) continue

      let currentOpacity = BASE_OPACITY
      let oldOpacity = BASE_OPACITY

      if (status === 'new') {
        currentOpacity = CHOSEN_OPACITY
        oldOpacity = REJECTED_OPACITY
      } else if (status === 'old') {
        currentOpacity = REJECTED_OPACITY
        oldOpacity = CHOSEN_OPACITY
      } else if (status === 'discuss') {
        currentOpacity = BASE_OPACITY
        oldOpacity = BASE_OPACITY
      }

      for (const id of current) updates.push({ id, type: 'geo', opacity: currentOpacity })
      for (const id of old) updates.push({ id, type: 'geo', opacity: oldOpacity })
    }

    if (updates.length > 0) editor.updateShapes(updates)
    lastReviews = reviews
  }

  applyReviewState()
  yRecords.observe(applyReviewState)

  return () => {
    yRecords.unobserve(applyReviewState)
  }
}

/**
 * Set up pulse effect for DiffData (used in diff toggle mode).
 */
function setupPulseForDiffData(
  editor: Editor,
  docName: string,
  dd: DiffData,
  focusChangeRef: React.MutableRefObject<((currentPage: number) => void) | null>,
) {
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let pulseTimer: ReturnType<typeof setTimeout> | null = null

  focusChangeRef.current = (currentPage: number) => {
    const hlIds: TLShapeId[] = []
    const baseOpacities: number[] = []
    for (let i = 0; i < dd.highlights.length; i++) {
      if (dd.highlights[i].currentPage === currentPage) {
        const hlId = createShapeId(`${docName}-diff-hl-${i}`)
        const shape = editor.getShape(hlId)
        hlIds.push(hlId)
        baseOpacities.push(shape?.opacity ?? 0.07)
      }
    }
    if (hlIds.length === 0) return

    if (delayTimer) clearTimeout(delayTimer)
    if (pulseTimer) clearTimeout(pulseTimer)

    delayTimer = setTimeout(() => {
      editor.updateShapes(hlIds.map(id => ({ id, type: 'geo' as const, opacity: 0.4 })))
      pulseTimer = setTimeout(() => {
        editor.updateShapes(hlIds.map((id, j) => ({ id, type: 'geo' as const, opacity: baseOpacities[j] })))
      }, 700)
    }, 350)
  }
}

/**
 * Set up pulse effect for standalone diff docs (DiffLayout from document).
 */
function setupPulseForDiffLayout(
  editorRef: React.MutableRefObject<Editor | null>,
  docName: string,
  diff: { highlights: DiffHighlight[] },
  focusChangeRef: React.MutableRefObject<((currentPage: number) => void) | null>,
) {
  let delayTimer: ReturnType<typeof setTimeout> | null = null
  let pulseTimer: ReturnType<typeof setTimeout> | null = null

  focusChangeRef.current = (currentPage: number) => {
    const editor = editorRef.current
    if (!editor) return

    const hlIds: TLShapeId[] = []
    const baseOpacities: number[] = []
    for (let i = 0; i < diff.highlights.length; i++) {
      if (diff.highlights[i].currentPage === currentPage) {
        const hlId = createShapeId(`${docName}-diff-hl-${i}`)
        const shape = editor.getShape(hlId)
        hlIds.push(hlId)
        baseOpacities.push(shape?.opacity ?? 0.07)
      }
    }
    if (hlIds.length === 0) return

    if (delayTimer) clearTimeout(delayTimer)
    if (pulseTimer) clearTimeout(pulseTimer)

    delayTimer = setTimeout(() => {
      editor.updateShapes(hlIds.map(id => ({ id, type: 'geo' as const, opacity: 0.4 })))
      pulseTimer = setTimeout(() => {
        editor.updateShapes(hlIds.map((id, j) => ({ id, type: 'geo' as const, opacity: baseOpacities[j] })))
      }, 700)
    }, 350)
  }
}

function setupSvgEditor(editor: Editor, document: SvgDocument): {
  shapeIdSet: Set<TLShapeId>
  shapeIds: TLShapeId[]
  updateBounds: (bounds: any) => void
} {
  // Check if page shapes already exist (from sync)
  const existingAssets = editor.getAssets()
  const hasAssets = document.format === 'html'
    ? editor.getCurrentPageShapes().some(s => s.type === 'html-page')
    : existingAssets.some(a => a.props && 'name' in a.props && a.props.name === 'svg-page')

  if (!hasAssets) {
    if (document.format === 'html') {
      // Create html-page custom shapes (no assets needed)
      editor.createShapes(
        document.pages.map((page) => ({
          id: page.shapeId,
          type: 'html-page' as any,
          x: page.bounds.x,
          y: page.bounds.y,
          isLocked: true,
          props: {
            w: page.bounds.w,
            h: page.bounds.h,
            url: page.src,
          },
        }))
      )
    } else {
      // Create image assets + shapes for SVG/PNG pages
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

      editor.createShapes(
        document.pages.map(
          (page, i): TLShapePartial<TLImageShape> => ({
            id: page.shapeId,
            type: 'image',
            x: page.bounds.x,
            y: page.bounds.y,
            isLocked: true,
            opacity: document.diffLayout?.oldPageIndices.has(i) ? 0.5 : 1,
            props: {
              assetId: page.assetId,
              w: page.bounds.w,
              h: page.bounds.h,
            },
          })
        )
      )
    }
  }

  // Set up diff layout: old page opacity, highlight overlays
  // Check for existing diff shapes (from Yjs sync) by looking for the first highlight ID
  const diffExtraShapeIds: TLShapeId[] = []
  if (document.diffLayout) {
    const firstHlId = createShapeId(`${document.name}-diff-hl-0`)
    const hasDiffShapes = !!editor.getShape(firstHlId)
    if (!hasDiffShapes) {
      setupDiffOverlays(editor, document, diffExtraShapeIds)
    }
    // Always set up hover + review effects (work whether shapes came from creation or Yjs sync)
    setupDiffHoverEffect(editor, document)
    setupDiffReviewEffect(editor, document)
  }

  const shapeIds = [
    ...document.pages.map((page) => page.shapeId),
    ...diffExtraShapeIds,
  ]
  const shapeIdSet = new Set(shapeIds)

  // Don't let the user unlock the pages
  editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next) => {
    if (!shapeIdSet.has(next.id)) return next
    if (next.isLocked) return next
    return { ...prev, isLocked: true }
  })

  // Make sure the shapes are below any of the other shapes
  function makeSureShapesAreAtBottom() {
    const shapes = [...shapeIdSet]
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
  let targetBounds = document.pages.reduce(
    (acc, page) => acc.union(page.bounds),
    document.pages[0].bounds.clone()
  )

  function applyCameraBounds() {
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
    applyCameraBounds()
  })

  applyCameraBounds()

  return {
    shapeIdSet,
    shapeIds,
    updateBounds: (newBounds: any) => {
      targetBounds = newBounds
      applyCameraBounds()
    },
  }
}

