/**
 * Proof statement overlay — shows the current theorem statement in a
 * CanvasClipPanel while reading a cross-page proof.
 */
import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { react } from 'tldraw'
import type { Editor } from 'tldraw'
import type { TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import type { ProofData } from './svgDocumentLoader'
import { PDF_HEIGHT } from './layoutConstants'
import { CanvasClipPanel, type ClipBounds } from './CanvasClipPanel'
import './ProofStatementOverlay.css'

const MARGIN_INSET = 70

interface PageInfo {
  bounds: { x: number; y: number; width: number; height: number }
  width: number
  height: number
}

interface ProofStatementOverlayProps {
  mainEditor: Editor
  proofData: ProofData
  pages: PageInfo[]
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

export function ProofStatementOverlay({
  mainEditor,
  proofData,
  pages,
  shapeUtils,
  tools,
  licenseKey,
}: ProofStatementOverlayProps) {
  const [activePairIndex, setActivePairIndex] = useState<number>(-1)
  const activePairRef = useRef(-1)
  const [dismissed, setDismissed] = useState(false)
  const dismissedPairRef = useRef(-1)
  const [expanded, setExpanded] = useState(false)

  // Track which proof page is visible using TLDraw reactive subscription
  // (reacts to camera changes instead of polling every 200ms)
  useEffect(() => {
    const stop = react('proof-active-pair', () => {
      const cam = mainEditor.getCamera()
      const vb = mainEditor.getViewportScreenBounds()
      const centerY = -cam.y + (vb.y + vb.h / 2) / cam.z

      let closestPage = 0
      let closestDist = Infinity
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i]
        const pageCenterY = p.bounds.y + p.bounds.height / 2
        const dist = Math.abs(centerY - pageCenterY)
        if (dist < closestDist) {
          closestDist = dist
          closestPage = i
        }
      }

      const idx = proofData.pairs.findIndex(p =>
        p.proofPageIndices.includes(closestPage)
      )

      if (idx !== activePairRef.current) {
        if (idx !== dismissedPairRef.current) {
          setDismissed(false)
          dismissedPairRef.current = -1
        }
        setExpanded(false)
        activePairRef.current = idx
        setActivePairIndex(idx)
      }
    })
    return stop
  }, [mainEditor, pages, proofData])

  // Compute canvas bounds for a region (synctex coords → TLDraw canvas coords)
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

  const activePair = activePairIndex >= 0 ? proofData.pairs[activePairIndex] : null
  const statementRegion = activePairIndex >= 0 ? proofData.statementRegions[activePairIndex] : null

  const bounds = useMemo(() => {
    if (!statementRegion) return null
    return getCanvasBounds(statementRegion)
  }, [statementRegion, getCanvasBounds])

  // Jump to statement page on click
  const jumpToStatement = useCallback(() => {
    if (!statementRegion) return
    const pageIdx = statementRegion.page - 1
    const page = pages[pageIdx]
    if (!page) return
    const scaleY = page.bounds.height / PDF_HEIGHT
    const canvasY = page.bounds.y + statementRegion.yTop * scaleY
    mainEditor.centerOnPoint(
      { x: page.bounds.x + page.bounds.width / 2, y: canvasY },
      { animation: { duration: 300 } }
    )
  }, [mainEditor, statementRegion, pages])

  if (!activePair || dismissed) return null

  if (!expanded) {
    return (
      <div
        className="proof-overlay-pill"
        onClick={() => setExpanded(true)}
        onPointerDown={stopPropagation}
        onPointerUp={stopPropagation}
        onTouchStart={stopPropagation}
        onTouchEnd={stopPropagation}
        title="Show theorem statement"
      >
        <span className="proof-overlay-pill-title">{activePair?.title}</span>
        <span className="proof-overlay-pill-page">p.{statementRegion?.page}</span>
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
      className="proof-overlay"
    >
      <div className="proof-overlay-label" onClick={jumpToStatement} title="Click to jump to statement">
        <span className="proof-overlay-title">{activePair?.title}</span>
        <span className="proof-overlay-page">p.{statementRegion?.page}</span>
        <button
          className="proof-overlay-close"
          onClick={(e) => { e.stopPropagation(); setExpanded(false) }}
          title="Collapse"
        >
          ‹
        </button>
        <button
          className="proof-overlay-close"
          onClick={(e) => { e.stopPropagation(); setDismissed(true); dismissedPairRef.current = activePairIndex }}
          title="Dismiss"
        >
          ×
        </button>
      </div>
    </CanvasClipPanel>
  )
}

function stopPropagation(e: { stopPropagation: () => void }) {
  e.stopPropagation()
}
