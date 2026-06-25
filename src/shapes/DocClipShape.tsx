/**
 * DocClipShape — a canvas-level shape showing a fixed region of the document.
 *
 * Created by "peeling" a region from the doc viewer. Unlike fleet-docview
 * (which is a HUD shape that dynamically follows signals), this is a static
 * canvas shape positioned near the document pages. Persists in Yjs.
 *
 * Interaction: thin top bar is the grab handle — click to select (shows
 * tldraw resize handles), drag to move. Content area is a pannable
 * CanvasClipPanel. × close on hover.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import type { Editor } from 'tldraw'
import { useContext, useEffect, useMemo, useState } from 'react'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { DocContext } from '../PanelContext'
import { PDF_HEIGHT } from '../layoutConstants'
import { getSvgText, setSvgText } from '../stores/svgTextStore'
import { getPageUrl } from '../stores/pageUrlStore'
import { FLEET_SHAPE_TYPES } from './fleet-utils'

const BAR_H = 8

export class DocClipShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'doc-clip' as const
  static override props = {
    w: T.number,
    h: T.number,
    page: T.number,
    yTop: T.number,
    yBottom: T.number,
    label: T.string,
  }

  getDefaultProps() {
    return { w: 400, h: 300, page: 1, yTop: 0, yBottom: 300, label: '' }
  }

  component(shape: any) {
    return (
      <HTMLContainer style={{ pointerEvents: 'all' }}>
        <DocClipComponent shape={shape} />
      </HTMLContainer>
    )
  }

  getIndicatorPath(shape: any) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

function DocClipComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const mainEditor = (window as any).__tldraw_editor__ as Editor | undefined

  const { w, h, page, yTop, yBottom } = shape.props
  const contentH = h - BAR_H

  // Compute clip bounds from page/yTop/yBottom
  const bounds = useMemo((): ClipBounds | null => {
    if (!doc?.pages?.length || page <= 0) return null
    const pageIdx = page - 1
    if (pageIdx < 0 || pageIdx >= doc.pages.length) return null
    const pageBounds = doc.pages[pageIdx].bounds
    const scale = pageBounds.height / PDF_HEIGHT
    const canvasYTop = pageBounds.y + (yTop || 0) * scale
    const canvasYBottom = pageBounds.y + (yBottom || PDF_HEIGHT) * scale
    const regionH = Math.max(canvasYBottom - canvasYTop, pageBounds.height * 0.1)
    return {
      x: pageBounds.x,
      y: canvasYTop - 10,
      w: pageBounds.width,
      h: regionH + 20,
    }
  }, [doc, page, yTop, yBottom])

  // Prefetch SVG for the target page
  const [svgReady, setSvgReady] = useState(false)
  useEffect(() => {
    if (!doc?.pages?.length || !doc?.docName || page <= 0) { setSvgReady(false); return }
    const pageIdx = page - 1
    if (pageIdx < 0 || pageIdx >= doc.pages.length) { setSvgReady(false); return }
    const p = doc.pages[pageIdx]
    const sid = p.shapeId as string
    if (!sid) { setSvgReady(false); return }
    if (getSvgText(sid)) { setSvgReady(true); return }
    setSvgReady(false)
    const url = getPageUrl(pageIdx)
    if (!url) return
    fetch(url)
      .then(r => r.ok ? r.text() : null)
      .then(text => {
        if (text) {
          setSvgText(sid, text)
          setSvgReady(true)
        }
      })
      .catch(e => console.warn('[doc-clip] SVG fetch failed:', e.message))
  }, [doc, page])

  const shapeUtils = useMemo(() => {
    const all = (window as any).__tldraw_shape_utils__ || []
    const EXCLUDE = new Set([...FLEET_SHAPE_TYPES, 'fleet-pill', 'doc-clip'])
    return all.filter((u: any) => !EXCLUDE.has(u.type))
  }, [])

  const licenseKey = 'tldraw-2027-01-19/WyJhUGMwcWRBayIsWyIqLnF0bTI4NS5naXRodWIuaW8iXSw5LCIyMDI3LTAxLTE5Il0.Hq9z1V8oTLsZKgpB0pI3o/RXCoLOsh5Go7Co53YGqHNmtEO9Lv/iuyBPzwQwlxQoREjwkkFbpflOOPmQMwvQSQ'

  if (!mainEditor || !doc || !bounds || !svgReady) {
    return (
      <div
        className="doc-clip-shape"
        style={{ width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3, fontSize: 11 }}
      >
        {!doc ? 'No document' : !bounds ? 'Invalid region' : 'Loading…'}
      </div>
    )
  }

  // Camera: zoom to fit page width, center bounds region vertically
  const pageIdx = page - 1
  const pg = doc.pages[pageIdx]
  const zoom = pg ? w / pg.bounds.width : 1
  const boundsCenter = bounds.y + bounds.h / 2
  const camY = -(boundsCenter - (contentH / zoom) / 2)
  const cameraOverride = pg ? { x: -pg.bounds.x, y: camY, z: zoom } : undefined

  return (
    <div
      className="doc-clip-shape"
      style={{ width: w, height: h, position: 'relative' }}
    >
      {/* Top bar — drag handle. Does NOT stopEventPropagation so tldraw
          handles selection and translate natively. */}
      <div className="doc-clip-bar">
        {/* × close — hover only */}
        <button
          className="doc-clip-close"
          onPointerDown={(e: any) => stopEventPropagation(e)}
          onPointerUp={(e: any) => { e.stopPropagation(); editor.deleteShapes([shape.id]) }}
        >×</button>
      </div>

      {/* Content area — CanvasClipPanel captures pointer events for panning */}
      <div
        className="doc-clip-body"
        style={{ height: contentH }}
        onPointerDown={stopEventPropagation}
      >
        <CanvasClipPanel
          mainEditor={mainEditor}
          bounds={bounds}
          shapeUtils={shapeUtils}
          tools={[]}
          licenseKey={licenseKey}
          panelWidth={w}
          maxHeightFraction={1}
          readOnly
          cameraOverride={cameraOverride}
        />
      </div>
    </div>
  )
}
