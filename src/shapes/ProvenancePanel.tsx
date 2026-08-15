import { useEffect, useState } from 'react'
import { useEditor, useValue, type TLShapeId } from 'tldraw'
import { useProvenanceMode } from '../useProvenanceMode'
import {
  ProvenanceDetail,
  STATUS_COLORS,
  STATUS_LABELS,
  type RibbonSegment,
} from './UnderstandingLineShape'
import './provenance-overlays.css'

type ActiveSpan = {
  seg: RibbonSegment
  index: number
}

type RibbonShape = {
  id: TLShapeId
  y: number
  props: {
    segments?: string
  }
}

const RIBBON_ID = 'shape:understanding-ribbon' as TLShapeId

function parseSegments(raw: unknown): RibbonSegment[] {
  if (typeof raw !== 'string') return []
  try { return JSON.parse(raw) as RibbonSegment[] }
  catch { return [] }
}

function segmentHasProvenance(seg: RibbonSegment): boolean {
  return !!(seg.checkedByName || seg.checkedAt || seg.method || seg.reason || seg.taskId)
}

function StatusBadge({ status }: { status: RibbonSegment['status'] }) {
  return (
    <span className="provenance-status-badge" style={{ background: STATUS_COLORS[status] }}>
      {STATUS_LABELS[status]}
    </span>
  )
}

function ProvenanceCardBody({ active }: {
  active: ActiveSpan
}) {
  return (
    <>
      <div className="provenance-card-header">
        <StatusBadge status={active.seg.status} />
        <span className="provenance-card-lines">lines {active.seg.startLine}–{active.seg.endLine}</span>
        {active.seg.stale && <span className="provenance-card-stale">stale</span>}
      </div>
      {segmentHasProvenance(active.seg) ? (
        <ProvenanceDetail seg={active.seg} />
      ) : (
        <div className="provenance-muted">no provenance recorded</div>
      )}
    </>
  )
}

export function ProvenancePanel() {
  const mode = useProvenanceMode()
  const editor = useEditor()
  const [lastActive, setLastActive] = useState<ActiveSpan | null>(null)

  const hoveredSpan = useValue('provenance-panel-hovered-span', () => {
    const ribbon = editor.getShape(RIBBON_ID) as RibbonShape | undefined
    if (!ribbon?.props?.segments) return null
    if (editor.getHoveredShapeId() !== ribbon.id) return null
    const relY = editor.inputs.currentPagePoint.y - ribbon.y
    const segments = parseSegments(ribbon.props.segments)
    const index = segments.findIndex((seg) => relY >= seg.y1 && relY <= seg.y2)
    if (index < 0) return null
    return { seg: segments[index], index }
  }, [editor])

  useEffect(() => {
    if (hoveredSpan) setLastActive(hoveredSpan)
  }, [hoveredSpan])

  if (mode !== 'panel') return null

  return (
    <div
      className="provenance-panel"
      style={{
        position: 'fixed',
        top: 64,
        right: 12,
        width: 300,
        pointerEvents: 'auto',
        zIndex: 110,
      }}
    >
      {lastActive ? (
        <ProvenanceCardBody active={lastActive} />
      ) : (
        <div className="provenance-muted">hover a ribbon span</div>
      )}
    </div>
  )
}
