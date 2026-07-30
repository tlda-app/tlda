import { useEffect, useRef } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { fleetReportArtifactProps } from '../../shared/shapes/fleet-panel-schema.mjs'
import { FleetPanelButtonGroup } from './FleetPanelChrome'
import { beginFleetDragWithoutSnap, endFleetDragWithoutSnap } from './fleet-utils'
import './fleet-report-artifact.css'

const DEFAULT_W = 520
const DEFAULT_H = 360

export class FleetReportArtifactShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-report-artifact' as const
  static override props = fleetReportArtifactProps

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, userId: '', deviceId: '', url: '', title: 'Report artifact' }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true
  override onTranslateStart = () => beginFleetDragWithoutSnap(this.editor)
  override onTranslateEnd = () => endFleetDragWithoutSnap(this.editor)
  override onTranslateCancel = () => endFleetDragWithoutSnap(this.editor)

  component(shape: any) {
    return <FleetReportArtifactComponent shape={shape} />
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

function FleetReportArtifactComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const containerRef = useRef<HTMLDivElement>(null)
  const { w, h, url, title } = shape.props

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const stop = (e: PointerEvent | WheelEvent) => {
      if (el.contains(e.target as Node)) e.stopPropagation()
    }
    el.addEventListener('pointerdown', stop, true)
    el.addEventListener('wheel', stop, { capture: true, passive: false })
    return () => {
      el.removeEventListener('pointerdown', stop, true)
      el.removeEventListener('wheel', stop, true)
    }
  }, [])

  return (
    <HTMLContainer style={{ pointerEvents: 'all' }}>
      <div
        ref={containerRef}
        className="fleet-shape fleet-report-artifact-shape"
        style={{ width: w, height: h }}
        onPointerDown={stopEventPropagation}
      >
        <FleetPanelButtonGroup editor={editor} shape={shape} />
        <div className="fleet-report-artifact-header">
          <span className="fleet-report-artifact-title">{title || 'Report artifact'}</span>
        </div>
        <div className="fleet-report-artifact-frame-wrap">
          {url ? (
            /*
             * <object> has no sandbox attribute. A same-origin uploaded HTML/SVG
             * report embedded with <object> would execute as the app origin, so it
             * cannot provide the required parent/same-origin denial boundary.
             */
            <iframe
              className="fleet-report-artifact-frame"
              title={title || 'Report artifact'}
              src={url}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="fleet-report-artifact-empty">no artifact</div>
          )}
        </div>
      </div>
    </HTMLContainer>
  )
}
