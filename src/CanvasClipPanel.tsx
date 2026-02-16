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
import { useEffect, useMemo, useState } from 'react'
import { Tldraw, createTLStore, defaultShapeUtils } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLRecord } from 'tldraw'
import './CanvasClipPanel.css'

const DEFAULT_WIDTH = 600
const DEFAULT_MAX_HEIGHT_FRACTION = 0.4

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
  useEffect(() => {
    if (!editor || !bounds) return
    editor.setCameraOptions({
      constraints: {
        bounds: { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h },
        behavior: 'fixed',
        origin: { x: 0.5, y: 0.5 },
        padding: { x: 0, y: 0 },
        initialZoom: 'fit-x',
        baseZoom: 'fit-x',
      },
      zoomSteps: [1],
    })
    editor.setCamera(editor.getCamera(), { reset: true })
  }, [editor, bounds])

  // Panel height tracks content
  const canvasHeight = useMemo(() => {
    if (!bounds) return 100
    const h = bounds.h * (panelWidth / bounds.w)
    return Math.max(36, Math.min(h, window.innerHeight * maxHeightFraction))
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
      <div className="clip-panel-canvas" style={{ height: canvasHeight }}>
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
