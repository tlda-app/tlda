/**
 * Reference viewer — click on a \ref{} or \eqref{} in the document and see
 * the referenced content in a floating panel. Prev/next buttons cycle through
 * multiple refs on the same source line.
 *
 * Uses the same copy-store TLDraw pattern as ProofStatementOverlay.
 */
import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { Tldraw, createTLStore, defaultShapeUtils } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLRecord } from 'tldraw'
import type { LabelRegion } from './svgDocumentLoader'
import { PDF_HEIGHT } from './layoutConstants'
import './RefViewer.css'
const PANEL_WIDTH = 600
const MARGIN_INSET = 70

interface PageInfo {
  bounds: { x: number; y: number; width: number; height: number }
  width: number
  height: number
}

interface RefViewerProps {
  mainEditor: Editor
  pages: PageInfo[]
  /** All refs on the clicked line, in source order */
  refs: { label: string; region: LabelRegion }[]
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
  onClose: () => void
  /** Navigate main editor to the ref's location (saves camera for go-back) */
  onGoThere: (region: LabelRegion) => void
  /** Restore camera to position before last "go there" */
  onGoBack: () => void
  /** Whether there's a camera position to go back to */
  canGoBack: boolean
  /** Navigate to previous/next source line with refs */
  onPrevLine: () => void
  onNextLine: () => void
}

export function RefViewer({
  mainEditor,
  pages,
  refs,
  shapeUtils,
  tools,
  licenseKey,
  onClose,
  onGoThere,
  onGoBack,
  canGoBack,
  onPrevLine,
  onNextLine,
}: RefViewerProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)

  // Reset index when refs change
  useEffect(() => {
    setActiveIndex(0)
  }, [refs])

  // Create copy store
  const store = useMemo(() => {
    const allRecords = mainEditor.store.allRecords()
    const docRecords = allRecords.filter(r =>
      r.typeName === 'shape' || r.typeName === 'asset' ||
      r.typeName === 'page' || r.typeName === 'document'
    )
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

  // Compute canvas bounds for current ref
  const activeRef = refs[activeIndex]
  const getCanvasBounds = useCallback((region: { page: number; yTop: number; yBottom: number }) => {
    const pageIdx = region.page - 1
    const page = pages[pageIdx]
    if (!page) return null
    const scaleY = page.bounds.height / PDF_HEIGHT
    const yTop = page.bounds.y + region.yTop * scaleY
    const yBottom = page.bounds.y + region.yBottom * scaleY
    const PAD = 10
    const top = Math.max(page.bounds.y, yTop - PAD)
    const h = (yBottom - yTop) + PAD * 2
    return {
      x: page.bounds.x + MARGIN_INSET,
      y: top,
      w: page.bounds.width - MARGIN_INSET * 2,
      h: Math.min(h, page.bounds.y + page.bounds.height - top),
    }
  }, [pages])

  // Apply camera constraints when editor or active ref changes
  useEffect(() => {
    if (!editor || !activeRef) return
    const bounds = getCanvasBounds(activeRef.region)
    if (!bounds) return
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
  }, [editor, activeRef, getCanvasBounds])

  // Panel height tracks content
  const panelHeight = useMemo(() => {
    if (!activeRef) return 100
    const bounds = getCanvasBounds(activeRef.region)
    if (!bounds) return 100
    const h = bounds.h * (PANEL_WIDTH / bounds.w)
    return Math.max(36, Math.min(h, window.innerHeight * 0.4))
  }, [activeRef, getCanvasBounds])

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  if (refs.length === 0) return null

  return (
    <div
      className="ref-viewer"
      style={{ height: panelHeight + 20 }}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onTouchStart={stopPropagation}
      onTouchEnd={stopPropagation}
    >
      <div className="ref-viewer-label">
        <button
          className="ref-viewer-nav"
          onClick={() => onPrevLine()}
          title="Previous ref"
        >
          ‹
        </button>
        <span className="ref-viewer-title">
          {activeRef.region.displayLabel}
        </span>
        <button
          className="ref-viewer-nav"
          onClick={() => onNextLine()}
          title="Next ref"
        >
          ›
        </button>
        <span className="ref-viewer-page">p.{activeRef.region.page}</span>
        <button
          className="ref-viewer-action"
          onClick={() => onGoThere(activeRef.region)}
          title="Go to this location"
        >
          ↗
        </button>
        {canGoBack && (
          <button
            className="ref-viewer-action"
            onClick={onGoBack}
            title="Go back"
          >
            ↩
          </button>
        )}
        <button
          className="ref-viewer-close"
          onClick={() => onClose()}
        >
          ×
        </button>
      </div>
      <div className="ref-viewer-canvas" style={{ height: panelHeight }}>
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
