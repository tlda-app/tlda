/**
 * FleetDocViewShape — fleet HUD shape that shows a region of the current document.
 *
 * Replaces the fixed-position overlay panels (ProofStatementOverlay, RefViewer,
 * AnnotationViewer) with a movable, resizable fleet shape in the HUD.
 *
 * Modes:
 *   - 'proof': auto-tracks the theorem statement for the currently visible proof
 *   - 'ref':   pinned to a specific label (e.g. eq:simple-dual)
 *   - 'manual': user-selected page/region
 *
 * Data flows:
 *   - proof-info.json provides label regions + proof pairs
 *   - Main editor scroll position determines which proof is visible
 *   - CanvasClipPanel renders the doc region from the main editor's store
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  createShapeId,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import type { Editor } from 'tldraw'
import { useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { DocContext } from '../PanelContext'
import { PDF_HEIGHT, TARGET_WIDTH, PAGE_GAP } from '../layoutConstants'

const DEFAULT_W = 300
const DEFAULT_H = 250

export class FleetDocViewShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-docview' as const
  static override props = {
    w: T.number,
    h: T.number,
    mode: T.string,       // 'proof' | 'ref' | 'manual'
    label: T.string,      // for 'ref' mode: the label key (e.g. 'prop:bias-balance')
    page: T.number,       // for 'manual' mode: page number (1-indexed)
    yTop: T.number,       // for 'manual'/'ref': top y in PDF coords
    yBottom: T.number,    // for 'manual'/'ref': bottom y in PDF coords
    title: T.string,      // display title
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, mode: 'proof', label: '', page: 0, yTop: 0, yBottom: 0, title: '' }
  }

  component(shape: any) {
    return (
      <HTMLContainer style={{ pointerEvents: 'all' }}>
        <FleetDocViewComponent shape={shape} />
      </HTMLContainer>
    )
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

interface NavEntry { label: string; page: number; yTop: number; yBottom: number; title: string }

function FleetDocViewComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const doc = useContext(DocContext)

  const { w, h, mode, label, page, yTop, yBottom, title } = shape.props

  // Get the main editor (the one behind the HUD)
  const mainEditor = (window as any).__tldraw_editor__ as Editor | undefined

  // Navigation history stack
  const historyRef = useRef<NavEntry[]>([])
  const historyIdxRef = useRef(-1)

  // Listen for doc-link clicks — update this shape to show the clicked region.
  // Use mainEditor (not HUD editor) to ensure the update propagates via Yjs sync.
  const shapeIdRef = useRef(shape.id)
  shapeIdRef.current = shape.id
  const shapeTypeRef = useRef(shape.type)
  shapeTypeRef.current = shape.type
  useEffect(() => {
    function onNavigate(e: Event) {
      const detail = (e as CustomEvent).detail
      if (!detail || !mainEditor) return
      const pg = detail.page || 0
      const yt = detail.yTop || 0
      const yb = detail.yBottom || 0
      const lbl = detail.label || ''
      const displayTitle = lbl.replace(/^equation\./, 'eq ').replace(/^theorem\./, 'thm ') || `p.${pg}`
      // Push to navigation history
      const entry: NavEntry = { label: lbl, page: pg, yTop: yt, yBottom: yb, title: displayTitle }
      historyRef.current = [...historyRef.current.slice(0, historyIdxRef.current + 1), entry]
      historyIdxRef.current = historyRef.current.length - 1
      try {
        if (mainEditor.getShape(shapeIdRef.current)?.isLocked) {
          mainEditor.updateShape({ id: shapeIdRef.current, type: shapeTypeRef.current, isLocked: false })
        }
        mainEditor.updateShape({
          id: shapeIdRef.current, type: shapeTypeRef.current,
          props: { w, h, mode: pg ? 'manual' : 'ref', label: lbl, page: pg, yTop: yt, yBottom: yb, title: displayTitle },
        })
      } catch {}
    }
    window.addEventListener('docview-navigate', onNavigate)
    return () => window.removeEventListener('docview-navigate', onNavigate)
  }, [mainEditor, w, h])

  // Load proof-info for proof mode
  const [proofInfo, setProofInfo] = useState<any>(null)
  useEffect(() => {
    if (!doc?.docName) return
    fetch(`/docs/${doc.docName}/proof-info.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(setProofInfo)
      .catch(() => {})
  }, [doc?.docName])

  // Compute bounds based on mode
  const bounds = useMemo((): ClipBounds | null => {
    if (!doc?.pages?.length) return null

    if (mode === 'ref' && label && proofInfo?.labelRegions) {
      const region = proofInfo.labelRegions[label]
      if (!region) return null
      const pageIdx = region.page - 1
      if (pageIdx < 0 || pageIdx >= doc.pages.length) return null
      const pageBounds = doc.pages[pageIdx].bounds
      const scale = pageBounds.height / PDF_HEIGHT
      const canvasYTop = pageBounds.y + (region.yTop || 0) * scale
      const canvasYBottom = pageBounds.y + (region.yBottom || pageBounds.height / scale) * scale
      const regionH = Math.max(canvasYBottom - canvasYTop, pageBounds.height * 0.15)
      return {
        x: pageBounds.x,
        y: canvasYTop - 20,
        w: pageBounds.width,
        h: regionH + 40,
      }
    }

    if (mode === 'manual' && page > 0) {
      const pageIdx = page - 1
      if (pageIdx < 0 || pageIdx >= doc.pages.length) return null
      const pageBounds = doc.pages[pageIdx].bounds
      const scale = pageBounds.height / PDF_HEIGHT
      return {
        x: pageBounds.x,
        y: pageBounds.y + (yTop || 0) * scale,
        w: pageBounds.width,
        h: ((yBottom || PDF_HEIGHT) - (yTop || 0)) * scale,
      }
    }

    if (mode === 'proof' && proofInfo?.proofPairs && mainEditor) {
      // Find which proof the user is currently viewing
      const camera = mainEditor.getCamera()
      const viewport = mainEditor.getViewportPageBounds()
      const viewCenterY = viewport.y + viewport.h / 2

      // Find the proof pair whose body contains the view center
      for (const pair of proofInfo.proofPairs) {
        if (!pair.proofRegion || !pair.statementRegion) continue
        const proofPageIdx = pair.proofRegion.page - 1
        if (proofPageIdx < 0 || proofPageIdx >= doc.pages.length) continue
        const proofPageBounds = doc.pages[proofPageIdx].bounds
        const scale = proofPageBounds.height / PDF_HEIGHT
        const proofTop = proofPageBounds.y + (pair.proofRegion.yTop || 0) * scale
        const proofBottom = proofPageBounds.y + (pair.proofRegion.yBottom || PDF_HEIGHT) * scale

        if (viewCenterY >= proofTop && viewCenterY <= proofBottom) {
          // User is viewing this proof — show its statement
          const stmtPageIdx = pair.statementRegion.page - 1
          if (stmtPageIdx < 0 || stmtPageIdx >= doc.pages.length) continue
          const stmtPageBounds = doc.pages[stmtPageIdx].bounds
          const stmtScale = stmtPageBounds.height / PDF_HEIGHT
          const stmtTop = stmtPageBounds.y + (pair.statementRegion.yTop || 0) * stmtScale
          const stmtBottom = stmtPageBounds.y + (pair.statementRegion.yBottom || PDF_HEIGHT) * stmtScale
          return {
            x: stmtPageBounds.x,
            y: stmtTop - 10,
            w: stmtPageBounds.width,
            h: Math.max(stmtBottom - stmtTop + 20, stmtPageBounds.height * 0.1),
          }
        }
      }
      return null // not viewing any proof
    }

    return null
  }, [doc, mode, label, page, yTop, yBottom, proofInfo, mainEditor])

  // For proof mode, re-check on camera changes
  const [, forceUpdate] = useState(0)
  useEffect(() => {
    if (mode !== 'proof' || !mainEditor) return
    const unsub = mainEditor.store.listen(({ changes }) => {
      for (const [, to] of Object.values(changes.updated)) {
        if ((to as any).typeName === 'camera') {
          forceUpdate(n => n + 1)
          return
        }
      }
    }, { source: 'all', scope: 'session' })
    return unsub
  }, [mode, mainEditor])

  // Get shape utils from the window, excluding all fleet shape types. The
  // docview is supposed to show DOCUMENT content only — mirroring fleet-chat /
  // fleet-agents / fleet-search / fleet-docview into this panel causes them to
  // nest inside the docview DOM, which steals pointer/drag events from the
  // real chat shapes on the main canvas (drops land on a wrong-tree chat whose
  // parent has pointer-events: none).
  const shapeUtils = useMemo(() => {
    const all = (window as any).__tldraw_shape_utils__ || []
    const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview', 'fleet-pill'])
    return all.filter((u: any) => !FLEET_TYPES.has(u.type))
  }, [])
  // License key — hardcoded since we can't easily pass it through context to shapes
  const licenseKey = 'tldraw-2027-01-19/WyJhUGMwcWRBayIsWyIqLnF0bTI4NS5naXRodWIuaW8iXSw5LCIyMDI3LTAxLTE5Il0.Hq9z1V8oTLsZKgpB0pI3o/RXCoLOsh5Go7Co53YGqHNmtEO9Lv/iuyBPzwQwlxQoREjwkkFbpflOOPmQMwvQSQ'

  if (!mainEditor || !doc) {
    return (
      <div style={{ width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3, fontSize: 11 }}>
        No document
      </div>
    )
  }

  return (
    <div
      className="fleet-docview fleet-shape"
      style={{ width: w, height: h, position: 'relative' }}
      onPointerDown={stopEventPropagation}
    >
      {/* Right-edge button group — splits, layout, close. Same as other fleet shapes. */}
      <div className="fleet-btn-group" onPointerDown={(e: any) => e.stopPropagation()}>
        <button
          className="fleet-layout-btn"
          onPointerUp={(e: any) => {
            e.stopPropagation()
            if (!mainEditor) return
            const newId = createShapeId()
            mainEditor.createShape({
              id: newId,
              type: 'fleet-docview' as any,
              x: shape.x + w / 2 + 5,
              y: shape.y,
              isLocked: false,
              props: { w: w / 2 - 5, h, mode, label, page, yTop, yBottom, title },
            })
            if (mainEditor.getShape(shape.id)?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
            mainEditor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, w: w / 2 - 5 } })
          }}
          title="Split vertical (side by side)"
        >⬒</button>
        <button
          className="fleet-layout-btn"
          onPointerUp={(e: any) => {
            e.stopPropagation()
            if (!mainEditor) return
            const newId = createShapeId()
            mainEditor.createShape({
              id: newId,
              type: 'fleet-docview' as any,
              x: shape.x,
              y: shape.y + h / 2 + 5,
              isLocked: false,
              props: { w, h: h / 2 - 5, mode, label, page, yTop, yBottom, title },
            })
            if (mainEditor.getShape(shape.id)?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
            mainEditor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, h: h / 2 - 5 } })
          }}
          title="Split horizontal (stacked)"
        >⬓</button>
        <button
          className="fleet-layout-btn"
          onPointerUp={(e: any) => {
            e.stopPropagation()
            editor.setCurrentTool('select')
            editor.select(shape.id)
          }}
          title="Resize / move"
        >⊞</button>
        <button
          className="fleet-close-btn"
          onPointerUp={(e: any) => {
            e.stopPropagation()
            editor.deleteShapes([shape.id])
          }}
        >×</button>
      </div>
      {/* Top-right horizontal nav group — back/forward/go. Identically styled,
          separated from the right-edge group so the chrome isn't one heavy blob. */}
      <div className="fleet-btn-group fleet-btn-group-topright" onPointerDown={(e: any) => e.stopPropagation()}>
        <button
          className="fleet-layout-btn"
          disabled={historyIdxRef.current <= 0}
          onPointerUp={(e: any) => {
            e.stopPropagation()
            if (historyIdxRef.current <= 0 || !mainEditor) return
            historyIdxRef.current--
            const entry = historyRef.current[historyIdxRef.current]
            if (mainEditor.getShape(shape.id)?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
            mainEditor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, mode: 'manual', ...entry } })
          }}
          title="Back"
        >←</button>
        <button
          className="fleet-layout-btn"
          disabled={historyIdxRef.current >= historyRef.current.length - 1}
          onPointerUp={(e: any) => {
            e.stopPropagation()
            if (historyIdxRef.current >= historyRef.current.length - 1 || !mainEditor) return
            historyIdxRef.current++
            const entry = historyRef.current[historyIdxRef.current]
            if (mainEditor.getShape(shape.id)?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
            mainEditor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, mode: 'manual', ...entry } })
          }}
          title="Forward"
        >→</button>
        <button
          className="fleet-layout-btn"
          onPointerUp={(e: any) => {
            e.stopPropagation()
            if (!mainEditor || !bounds) return
            // Scroll only vertically — don't fuck with Skip's horizontal exposition.
            const vp = mainEditor.getViewportPageBounds()
            const currentXCenter = vp.x + vp.w / 2
            mainEditor.centerOnPoint(
              { x: currentXCenter, y: bounds.y + bounds.h / 2 },
              { animation: { duration: 300 } }
            )
          }}
          title="Go to this location in document"
        >↗</button>
      </div>
      <div className="fleet-docview-body" style={{ height: h }}>
        {bounds && mainEditor ? (
          <CanvasClipPanel
            mainEditor={mainEditor}
            bounds={bounds}
            shapeUtils={shapeUtils}
            tools={[]}
            licenseKey={licenseKey}
            panelWidth={w}
            maxHeightFraction={1}
            readOnly
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.15, fontSize: 11 }}>
            {mode === 'proof' ? 'scroll to a proof' : 'click a ref'}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * DocViewPortal — renders a CanvasClipPanel via React portal outside the
 * tldraw tree, positioned to overlay the shape's screen location.
 * This avoids the nested-tldraw crash (React error #300).
 */
function DocViewPortal({
  mainEditor, bounds, shapeUtils, licenseKey, panelWidth, panelHeight, shapeId, editor,
}: {
  mainEditor: Editor
  bounds: ClipBounds
  shapeUtils: any[]
  licenseKey: string
  panelWidth: number
  panelHeight: number
  shapeId: string
  editor: Editor
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  // Create a portal container div
  useEffect(() => {
    const el = document.createElement('div')
    el.className = 'fleet-docview-portal'
    el.style.position = 'fixed'
    el.style.zIndex = '99999'
    el.style.pointerEvents = 'none'
    document.body.appendChild(el)
    containerRef.current = el
    return () => { el.remove(); containerRef.current = null }
  }, [])

  // Track the shape's screen position by finding its DOM element
  useEffect(() => {
    const update = () => {
      const shapeEl = document.querySelector(`[data-shape-id="${shapeId}"]`)
      if (!shapeEl) return
      const bodyEl = shapeEl.querySelector('.fleet-docview-body')
      if (!bodyEl) return
      const rect = bodyEl.getBoundingClientRect()
      setPos({ x: rect.left, y: rect.top })
      if (containerRef.current) {
        containerRef.current.style.left = rect.left + 'px'
        containerRef.current.style.top = rect.top + 'px'
        containerRef.current.style.width = rect.width + 'px'
        containerRef.current.style.height = rect.height + 'px'
        containerRef.current.style.pointerEvents = 'auto'
      }
    }
    update()
    const interval = setInterval(update, 500)
    return () => clearInterval(interval)
  }, [shapeId])

  if (!containerRef.current || !pos) return null

  return createPortal(
    <CanvasClipPanel
      mainEditor={mainEditor}
      bounds={bounds}
      shapeUtils={shapeUtils}
      tools={[]}
      licenseKey={licenseKey}
      panelWidth={panelWidth}
      maxHeightFraction={1}
      readOnly
    />,
    containerRef.current,
  )
}
