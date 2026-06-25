import { useEffect, useMemo, useState } from 'react'
import { useEditor, useValue, type TLShapeId } from 'tldraw'
import { fetchProofInfo } from '../docInfoCache'
import { invalidationFromRanges } from '../invalidationGraph'
import { useProvenanceMode } from '../useProvenanceMode'
import { CascadeGraph, type CascadeGraphNode } from './CascadeGraph'
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

function cascadeNodes(proofInfo: any, seg: RibbonSegment): CascadeGraphNode[] {
  const lo = Math.min(seg.startLine, seg.endLine)
  const hi = Math.max(seg.startLine, seg.endLine)
  const { directlyStale, cascadeStale } = invalidationFromRanges(proofInfo, [{ lo, hi }])
  const direct: CascadeGraphNode[] = directlyStale
    .map((n) => ({ id: n.id, title: n.title || n.id, stale: 'direct' }))
  const cascade: CascadeGraphNode[] = cascadeStale.map((n) => ({
    id: n.id,
    title: n.title || n.id,
    stale: 'cascade',
    depth: n.depth,
    via: n.via,
  }))
  return direct.concat(cascade)
}

function StatusBadge({ status }: { status: RibbonSegment['status'] }) {
  return (
    <span className="provenance-status-badge" style={{ background: STATUS_COLORS[status] }}>
      {STATUS_LABELS[status]}
    </span>
  )
}

function ProvenanceCardBody({ docName, active, graphWidth }: {
  docName: string
  active: ActiveSpan
  graphWidth: number
}) {
  const [proofInfo, setProofInfo] = useState<any>(null)

  useEffect(() => {
    let cancelled = false
    if (!active.seg.stale) {
      setProofInfo(null)
      return
    }
    fetchProofInfo(docName).then((info) => {
      if (!cancelled) setProofInfo(info)
    })
    return () => { cancelled = true }
  }, [docName, active.index, active.seg.stale])

  const nodes = useMemo(
    () => active.seg.stale && proofInfo ? cascadeNodes(proofInfo, active.seg) : [],
    [active.seg, proofInfo],
  )

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
      <div className="provenance-cascade">
        <div className="provenance-cascade-title">Cascade</div>
        {active.seg.stale && nodes.length > 0 ? (
          <CascadeGraph nodes={nodes} width={graphWidth} onApprove={() => {}} />
        ) : (
          <div className="provenance-muted">fresh — no cascade</div>
        )}
      </div>
    </>
  )
}

export function ProvenancePanel({ docName }: { docName: string }) {
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
        <ProvenanceCardBody docName={docName} active={lastActive} graphWidth={280} />
      ) : (
        <div className="provenance-muted">hover a ribbon span</div>
      )}
    </div>
  )
}
