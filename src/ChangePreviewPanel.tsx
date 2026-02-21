/**
 * ChangePreviewPanel — shows the old version of a selected change
 * in a CanvasClipPanel, so you can see what changed even when the
 * old text is on a different page or far away.
 */
import { useMemo, useCallback, useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import type { ChangeItem } from './historyStore'
import { CanvasClipPanel, type ClipBounds } from './CanvasClipPanel'
import { PDF_HEIGHT } from './layoutConstants'
import './ChangePreviewPanel.css'

const MARGIN_INSET = 70
// viewBox origin offset (dvisvgm uses -72 -72 612 792)
const VB_ORIGIN_Y = -72

interface ChangePreviewPanelProps {
  mainEditor: Editor
  selectedChangeId: string | null
  historyChanges: ChangeItem[]
  docName: string
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
  onSelectChange: (id: string | null) => void
}

export function ChangePreviewPanel({
  mainEditor,
  selectedChangeId,
  historyChanges,
  docName,
  shapeUtils,
  tools,
  licenseKey,
  onSelectChange,
}: ChangePreviewPanelProps) {
  const cameraHistoryRef = useRef<Array<{ x: number; y: number; z: number }>>([])
  const [canGoBack, setCanGoBack] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const selectedIndex = useMemo(() => {
    if (!selectedChangeId) return -1
    return historyChanges.findIndex(c => c.id === selectedChangeId)
  }, [selectedChangeId, historyChanges])

  const selectedChange = selectedIndex >= 0 ? historyChanges[selectedIndex] : null

  // Compute bounds on the old page shape for the selected change's old lines
  const bounds = useMemo((): ClipBounds | null => {
    if (!selectedChange || !selectedChange.oldLines || selectedChange.oldLines.length === 0) return null

    const oldShapeId = `shape:${docName}-hist-old-${selectedChange.page}`
    const shape = mainEditor.getShape(oldShapeId as any)
    if (!shape) return null

    const props = shape.props as any
    const shapeW = props.w as number
    const shapeH = props.h as number

    const lines = selectedChange.oldLines
    const minY = Math.min(...lines.map(l => l.y))
    const maxY = Math.max(...lines.map(l => l.y + l.height))

    const fracTop = (minY - VB_ORIGIN_Y) / PDF_HEIGHT
    const fracBottom = (maxY - VB_ORIGIN_Y) / PDF_HEIGHT

    const PAD = 10
    const canvasTop = shape.y + fracTop * shapeH - PAD
    const canvasBottom = shape.y + fracBottom * shapeH + PAD

    return {
      x: shape.x + MARGIN_INSET,
      y: Math.max(shape.y, canvasTop),
      w: shapeW - MARGIN_INSET * 2,
      h: Math.min(canvasBottom - canvasTop, shapeH),
    }
  }, [selectedChange, docName, mainEditor])

  // Jump to old page location
  const handleGoThere = useCallback(() => {
    if (!bounds) return
    const cam = mainEditor.getCamera()
    cameraHistoryRef.current.push({ x: cam.x, y: cam.y, z: cam.z })
    setCanGoBack(true)
    mainEditor.centerOnPoint(
      { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 },
      { animation: { duration: 300 } }
    )
  }, [mainEditor, bounds])

  // Restore camera
  const handleGoBack = useCallback(() => {
    const history = cameraHistoryRef.current
    if (history.length === 0) return
    const cam = history.pop()!
    setCanGoBack(history.length > 0)
    mainEditor.setCamera(cam, { animation: { duration: 300 } })
  }, [mainEditor])

  // Prev/next change
  const handlePrev = useCallback(() => {
    if (selectedIndex <= 0) return
    onSelectChange(historyChanges[selectedIndex - 1].id)
  }, [selectedIndex, historyChanges, onSelectChange])

  const handleNext = useCallback(() => {
    if (selectedIndex < 0 || selectedIndex >= historyChanges.length - 1) return
    onSelectChange(historyChanges[selectedIndex + 1].id)
  }, [selectedIndex, historyChanges, onSelectChange])

  if (!selectedChange || !bounds) return null

  const snippet = selectedChange.oldText
    ? (selectedChange.oldText.length > 40 ? selectedChange.oldText.slice(0, 37) + '\u2026' : selectedChange.oldText)
    : 'old version'

  if (!expanded) {
    return (
      <div
        className="change-preview-pill"
        onClick={() => setExpanded(true)}
        onPointerDown={stopEventPropagation}
        onPointerUp={stopEventPropagation}
        onTouchStart={stopEventPropagation}
        onTouchEnd={stopEventPropagation}
        title="Show old version"
      >
        <button
          className="change-preview-pill-nav"
          onClick={(e) => { e.stopPropagation(); handlePrev() }}
          disabled={selectedIndex <= 0}
        >‹</button>
        <span className="change-preview-pill-title">{snippet}</span>
        <span className="change-preview-pill-page">p.{selectedChange.page}</span>
        <button
          className="change-preview-pill-nav"
          onClick={(e) => { e.stopPropagation(); handleNext() }}
          disabled={selectedIndex >= historyChanges.length - 1}
        >›</button>
        <button
          className="change-preview-pill-close"
          onClick={(e) => { e.stopPropagation(); onSelectChange(null) }}
          title="Deselect"
        >×</button>
      </div>
    )
  }

  return (
    <CanvasClipPanel
      mainEditor={mainEditor}
      bounds={bounds}
      shapeUtils={shapeUtils}
      tools={tools}
      licenseKey={licenseKey}
      className="change-preview"
    >
      <div className="change-preview-label">
        <button
          className="change-preview-nav"
          onClick={(e) => { e.stopPropagation(); handlePrev() }}
          title="Previous change"
          disabled={selectedIndex <= 0}
        >
          ‹
        </button>
        <span className="change-preview-title">{snippet}</span>
        <button
          className="change-preview-nav"
          onClick={(e) => { e.stopPropagation(); handleNext() }}
          title="Next change"
          disabled={selectedIndex >= historyChanges.length - 1}
        >
          ›
        </button>
        <span className="change-preview-page">p.{selectedChange.page}</span>
        <button
          className="change-preview-action"
          onClick={(e) => { e.stopPropagation(); handleGoThere() }}
          title="Go to old location"
        >
          ↗
        </button>
        {canGoBack && (
          <button
            className="change-preview-action"
            onClick={(e) => { e.stopPropagation(); handleGoBack() }}
            title="Go back"
          >
            ↩
          </button>
        )}
        <button
          className="change-preview-action"
          onClick={(e) => { e.stopPropagation(); setExpanded(false) }}
          title="Collapse"
        >
          ▾
        </button>
        <button
          className="change-preview-close"
          onClick={(e) => { e.stopPropagation(); onSelectChange(null) }}
          title="Close"
        >
          ×
        </button>
      </div>
    </CanvasClipPanel>
  )
}
