/**
 * Reference viewer — click on a \ref{} or \eqref{} in the document and see
 * the referenced content in a floating panel.
 *
 * Uses CanvasClipPanel for the copy-store TLDraw display.
 */
import { useEffect, useMemo, useState, useCallback } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import type { LabelRegion } from './svgDocumentLoader'
import { PDF_HEIGHT } from './layoutConstants'
import { CanvasClipPanel, type ClipBounds } from './CanvasClipPanel'
import './RefViewer.css'

const MARGIN_INSET = 70

interface PageInfo {
  bounds: { x: number; y: number; width: number; height: number }
  width: number
  height: number
}

interface RefViewerProps {
  mainEditor: Editor
  pages: PageInfo[]
  refs: { label: string; region: LabelRegion }[]
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
  onClose: () => void
  onGoThere: (region: LabelRegion) => void
  onGoBack: () => void
  canGoBack: boolean
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

  // Reset index when refs change
  useEffect(() => {
    setActiveIndex(0)
  }, [refs])

  // Compute canvas bounds for current ref
  const activeRef = refs[activeIndex]
  const getCanvasBounds = useCallback((region: { page: number; yTop: number; yBottom: number }): ClipBounds | null => {
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

  const bounds = useMemo(() => {
    if (!activeRef) return null
    return getCanvasBounds(activeRef.region)
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
    <CanvasClipPanel
      mainEditor={mainEditor}
      bounds={bounds}
      shapeUtils={shapeUtils}
      tools={tools}
      licenseKey={licenseKey}
      className="ref-viewer"
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
    </CanvasClipPanel>
  )
}
