/**
 * CanvasClipPanel — shared copy-store TLDraw panel that shows a clipped
 * region of the main canvas. Used by ProofStatementOverlay, RefViewer,
 * and ChangePreviewPanel.
 *
 * Creates a one-way synced copy of the main editor's store and constrains
 * the camera to show only the specified bounds region.
 *
 * Label bar content is passed as children — each consumer renders its own
 * buttons and title.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Tldraw, createTLStore, defaultShapeUtils } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLRecord } from 'tldraw'
import './CanvasClipPanel.css'

const DEFAULT_WIDTH = 600
const DEFAULT_MAX_HEIGHT_FRACTION = 0.4
const MIN_VISIBLE_LINES = 5
const LINE_HEIGHT_ESTIMATE = 14 // ~12pt in PDF coordinates

export interface ClipBounds {
  x: number
  y: number
  w: number
  h: number
}

interface CanvasClipPanelProps {
  mainEditor: Editor
  bounds: ClipBounds | null
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
  panelWidth?: number
  maxHeightFraction?: number
  className?: string
  children?: React.ReactNode
}

export function CanvasClipPanel({
  mainEditor,
  bounds,
  shapeUtils,
  tools,
  licenseKey,
  panelWidth = DEFAULT_WIDTH,
  maxHeightFraction = DEFAULT_MAX_HEIGHT_FRACTION,
  className,
  children,
}: CanvasClipPanelProps) {
  const [editor, setEditor] = useState<Editor | null>(null)

  // Create copy store from main editor's document records
  const store = useMemo(() => {
    const allRecords = mainEditor.store.allRecords()
    const docRecords = allRecords.filter(isDocRecord)
    const s = createTLStore({ shapeUtils: [...defaultShapeUtils, ...shapeUtils] })
    s.mergeRemoteChanges(() => { s.put(docRecords) })
    return s
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One-way sync: main store → copy store
  useEffect(() => {
    const unsub = mainEditor.store.listen(({ changes }) => {
      store.mergeRemoteChanges(() => {
        for (const record of Object.values(changes.added)) {
          if (isDocRecord(record)) store.put([record])
        }
        for (const [, to] of Object.values(changes.updated)) {
          if (isDocRecord(to)) store.put([to])
        }
        for (const record of Object.values(changes.removed)) {
          if (isDocRecord(record)) {
            try { store.remove([record.id]) } catch { /* might not exist */ }
          }
        }
      })
    }, { source: 'all', scope: 'document' })
    return unsub
  }, [mainEditor.store, store])

  // Apply camera constraints when bounds change
  // Use clip bounds for initial position, full page extent for scroll range
  useEffect(() => {
    if (!editor || !bounds) return

    // Find the vertical extent of all page shapes for scroll range
    let minY = bounds.y
    let maxY = bounds.y + bounds.h
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type === 'svg-page') {
        const geo = editor.getShapeGeometry(shape)
        if (geo) {
          minY = Math.min(minY, shape.y)
          maxY = Math.max(maxY, shape.y + geo.bounds.h)
        }
      }
    }

    editor.setCameraOptions({
      constraints: {
        bounds: { x: bounds.x, y: minY, w: bounds.w, h: maxY - minY },
        behavior: 'inside',
        origin: { x: 0.5, y: 0 },
        padding: { x: 0, y: 0 },
        initialZoom: 'fit-x',
        baseZoom: 'fit-x',
      },
      zoomSteps: [0.5, 1, 2],
    })

    // Position camera to show the clip region, centered vertically
    const zoom = panelWidth / bounds.w
    const contentScreenH = bounds.h * zoom
    const minScreenH = MIN_VISIBLE_LINES * LINE_HEIGHT_ESTIMATE * zoom
    const viewportH = Math.max(minScreenH, Math.min(contentScreenH, window.innerHeight * DEFAULT_MAX_HEIGHT_FRACTION))
    // Center the bounds vertically if viewport is taller than content
    const yOffset = (viewportH > contentScreenH)
      ? (viewportH - contentScreenH) / (2 * zoom)
      : 0
    editor.setCamera({ x: -bounds.x, y: -(bounds.y - yOffset), z: zoom })
  }, [editor, bounds, panelWidth])

  // Wheel to pan vertically
  const canvasRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = canvasRef.current
    if (!el || !editor) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const cam = editor.getCamera()
      const dy = e.deltaY / cam.z
      editor.setCamera({ x: cam.x, y: cam.y - dy, z: cam.z })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [editor])

  // Panel height: at least 5 lines, at most maxHeightFraction of viewport
  const canvasHeight = useMemo(() => {
    if (!bounds) return 100
    const zoom = panelWidth / bounds.w
    const contentH = bounds.h * zoom
    const minH = MIN_VISIBLE_LINES * LINE_HEIGHT_ESTIMATE * zoom
    return Math.max(minH, Math.min(contentH, window.innerHeight * maxHeightFraction))
  }, [bounds, panelWidth, maxHeightFraction])

  if (!bounds) return null

  return (
    <div
      className={`clip-panel ${className || ''}`}
      style={{ width: panelWidth, height: canvasHeight + 20 }}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onTouchStart={stopPropagation}
      onTouchEnd={stopPropagation}
    >
      {children}
      <div ref={canvasRef} className="clip-panel-canvas" style={{ height: canvasHeight }}>
        <Tldraw
          store={store}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={licenseKey}
          hideUi
          autoFocus={false}
          forceMobile
          onMount={(ed) => setEditor(ed)}
        />
      </div>
    </div>
  )
}

function isDocRecord(record: TLRecord): boolean {
  return record.typeName === 'shape' || record.typeName === 'asset' ||
    record.typeName === 'page' || record.typeName === 'document'
}

function stopPropagation(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}
