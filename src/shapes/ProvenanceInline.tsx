import { useCallback, useEffect, useMemo, useState } from 'react'
import { stopEventPropagation, useEditor, useValue, type TLShapeId } from 'tldraw'
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

const HIT_WIDTH = 14

type PinnedSpan = {
  seg: RibbonSegment
  index: number
}

type RibbonShape = {
  id: TLShapeId
  x: number
  y: number
  props: {
    w: number
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

function InlineBody({ projectName, pinned }: { projectName: string; pinned: PinnedSpan }) {
  const [proofInfo, setProofInfo] = useState<any>(null)

  useEffect(() => {
    let cancelled = false
    if (!pinned.seg.stale) {
      setProofInfo(null)
      return
    }
    fetchProofInfo(projectName).then((info) => {
      if (!cancelled) setProofInfo(info)
    })
    return () => { cancelled = true }
  }, [projectName, pinned.index, pinned.seg.stale])

  const nodes = useMemo(
    () => pinned.seg.stale && proofInfo ? cascadeNodes(proofInfo, pinned.seg) : [],
    [pinned.seg, proofInfo],
  )

  return (
    <>
      <div className="provenance-card-header">
        <StatusBadge status={pinned.seg.status} />
        <span className="provenance-card-lines">lines {pinned.seg.startLine}–{pinned.seg.endLine}</span>
        {pinned.seg.stale && <span className="provenance-card-stale">stale</span>}
      </div>
      {segmentHasProvenance(pinned.seg) ? (
        <ProvenanceDetail seg={pinned.seg} />
      ) : (
        <div className="provenance-muted">no provenance recorded</div>
      )}
      <div className="provenance-cascade">
        <div className="provenance-cascade-title">Cascade</div>
        {pinned.seg.stale && nodes.length > 0 ? (
          <CascadeGraph nodes={nodes} width={240} onApprove={() => {}} />
        ) : (
          <div className="provenance-muted">fresh — no cascade</div>
        )}
      </div>
    </>
  )
}

export function ProvenanceInline({ projectName }: { projectName: string }) {
  const mode = useProvenanceMode()
  const editor = useEditor()
  const [pinned, setPinned] = useState<PinnedSpan | null>(null)

  const ribbonState = useValue('provenance-inline-ribbon-state', () => {
    const ribbon = editor.getShape(RIBBON_ID) as RibbonShape | undefined
    if (!ribbon?.props?.segments) return null
    const bounds = editor.getShapePageBounds(ribbon.id)
    if (!bounds) return null
    const topLeft = editor.pageToScreen({ x: bounds.minX, y: bounds.minY })
    const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
    return {
      ribbon,
      segments: parseSegments(ribbon.props.segments),
      screen: {
        left: topLeft.x,
        top: topLeft.y,
        width: Math.max(HIT_WIDTH, bottomRight.x - topLeft.x),
        height: Math.max(1, bottomRight.y - topLeft.y),
      },
    }
  }, [editor])

  const cardStyle = useMemo(() => {
    if (!ribbonState || !pinned) return null
    const y = ribbonState.ribbon.y + (pinned.seg.y1 + pinned.seg.y2) / 2
    const p = editor.pageToScreen({ x: ribbonState.ribbon.x + ribbonState.ribbon.props.w, y })
    return { left: p.x + 10, top: p.y }
  }, [editor, ribbonState, pinned])

  const pinFromClientY = useCallback((clientY: number) => {
    if (!ribbonState) return
    const pagePoint = editor.screenToPage({ x: ribbonState.screen.left, y: clientY })
    const relY = pagePoint.y - ribbonState.ribbon.y
    const index = ribbonState.segments.findIndex((seg) => relY >= seg.y1 && relY <= seg.y2)
    if (index < 0) {
      setPinned(null)
      return
    }
    setPinned({ seg: ribbonState.segments[index], index })
  }, [editor, ribbonState])

  if (mode !== 'inline' || !ribbonState) return null

  return (
    <>
      <div
        style={{
          position: 'fixed',
          left: ribbonState.screen.left,
          top: ribbonState.screen.top,
          width: HIT_WIDTH,
          height: ribbonState.screen.height,
          pointerEvents: 'auto',
          zIndex: 90,
        }}
        onPointerDown={(e) => {
          stopEventPropagation(e)
          pinFromClientY(e.clientY)
        }}
      />
      {pinned && cardStyle && (
        <div
          className="provenance-inline-card"
          style={{
            position: 'fixed',
            left: cardStyle.left,
            top: cardStyle.top,
            width: 260,
            maxHeight: '70vh',
            overflow: 'auto',
            pointerEvents: 'auto',
            transform: 'translateY(-50%)',
            zIndex: 115,
          }}
          onPointerDown={(e) => stopEventPropagation(e)}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <InlineBody projectName={projectName} pinned={pinned} />
            </div>
            <button
              type="button"
              className="provenance-close"
              aria-label="Close provenance card"
              onPointerUp={(e) => {
                stopEventPropagation(e)
                setPinned(null)
              }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </>
  )
}
