/**
 * Proof statement overlay — shows the current theorem statement in a TLDraw
 * mini-editor with camera constraints while reading a cross-page proof.
 *
 * One-way sync: main store → copy store (document-scoped records).
 */
import { useEffect, useRef, useMemo, useState, useCallback } from 'react'
import { Tldraw, createTLStore, defaultShapeUtils } from 'tldraw'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLRecord } from 'tldraw'
import type { ProofData } from './svgDocumentLoader'
import './ProofStatementOverlay.css'

const PDF_HEIGHT = 792
const PANEL_WIDTH = 600
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
  const [stmtEditor, setStmtEditor] = useState<Editor | null>(null)
  const activePairRef = useRef(-1)
  const [dismissed, setDismissed] = useState(false)
  const dismissedPairRef = useRef(-1)
  const [expanded, setExpanded] = useState(false)

  // Create copy store
  const stmtStore = useMemo(() => {
    const allRecords = mainEditor.store.allRecords()
    const docRecords = allRecords.filter(r =>
      r.typeName === 'shape' || r.typeName === 'asset' ||
      r.typeName === 'page' || r.typeName === 'document'
    )
    const store = createTLStore({ shapeUtils: [...defaultShapeUtils, ...shapeUtils] })
    store.mergeRemoteChanges(() => { store.put(docRecords) })
    return store
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One-way sync: main store → copy store
  useEffect(() => {
    const unsub = mainEditor.store.listen(({ changes }) => {
      stmtStore.mergeRemoteChanges(() => {
        for (const record of Object.values(changes.added)) {
          if (isDocRecord(record)) stmtStore.put([record])
        }
        for (const [, to] of Object.values(changes.updated)) {
          if (isDocRecord(to)) stmtStore.put([to])
        }
        for (const record of Object.values(changes.removed)) {
          if (isDocRecord(record)) {
            try { stmtStore.remove([record.id]) } catch { /* might not exist */ }
          }
        }
      })
    }, { source: 'all', scope: 'document' })
    return unsub
  }, [mainEditor.store, stmtStore])

  // Track which proof page is visible using polling
  useEffect(() => {
    const computeActivePair = () => {
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
        // Clear dismissed/expanded state when scrolling to a different proof (or away from any proof)
        if (idx !== dismissedPairRef.current) {
          setDismissed(false)
          dismissedPairRef.current = -1
        }
        setExpanded(false)
        activePairRef.current = idx
        setActivePairIndex(idx)
      }
    }

    computeActivePair()
    const timerId = setInterval(computeActivePair, 200)
    return () => clearInterval(timerId)
  }, [mainEditor, pages, proofData])

  // Compute canvas bounds for a region (synctex coords → TLDraw canvas coords)
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

  // Apply camera constraints when editor or active pair changes
  useEffect(() => {
    if (!stmtEditor || activePairIndex < 0) return
    const region = proofData.statementRegions[activePairIndex]
    if (!region) return
    const bounds = getCanvasBounds(region)
    if (!bounds) return
    stmtEditor.setCameraOptions({
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
    stmtEditor.setCamera(stmtEditor.getCamera(), { reset: true })
  }, [stmtEditor, activePairIndex, proofData, getCanvasBounds])

  const activePair = activePairIndex >= 0 ? proofData.pairs[activePairIndex] : null
  const statementRegion = activePairIndex >= 0 ? proofData.statementRegions[activePairIndex] : null

  // Panel height tracks content
  const overlayHeight = useMemo(() => {
    if (!statementRegion) return 120
    const bounds = getCanvasBounds(statementRegion)
    if (!bounds) return 120
    const h = bounds.h * (PANEL_WIDTH / bounds.w)
    return Math.max(36, Math.min(h, window.innerHeight * 0.4))
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
    // Collapsed: subtle pill hint
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
    <div
      className="proof-overlay"
      style={{ height: overlayHeight + 20 }}
      onPointerDown={stopPropagation}
      onPointerUp={stopPropagation}
      onTouchStart={stopPropagation}
      onTouchEnd={stopPropagation}
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
      <div className="proof-overlay-canvas" style={{ height: overlayHeight }}>
        <Tldraw
          store={stmtStore}
          shapeUtils={shapeUtils}
          tools={tools}
          licenseKey={licenseKey}
          hideUi
          autoFocus={false}
          forceMobile
          onMount={(editor) => setStmtEditor(editor)}
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
