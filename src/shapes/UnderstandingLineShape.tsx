import { useEffect, useRef, useState } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  Rectangle2d,
  T,
  useEditor,
  useValue,
} from 'tldraw'
import { useProvenanceMode } from '../useProvenanceMode'

export type LineStatus = 'approved' | 'understood' | 'presentation' | 'uncertain' | 'rejected' | 'unchecked'

export const STATUS_COLORS: Record<LineStatus, string> = {
  approved: '#16a34a',
  understood: '#059669',
  presentation: '#3b82f6',
  uncertain: '#ca8a04',
  rejected: '#dc2626',
  unchecked: '#9ca3af',
}

export const STATUS_LABELS: Record<LineStatus, string> = {
  approved: 'approved',
  understood: 'understood',
  presentation: 'presentation',
  uncertain: 'uncertain',
  rejected: 'rejected',
  unchecked: 'unchecked',
}

export const HIGHLIGHT_TO_STATUS: Record<string, LineStatus | undefined> = {
  'light-green': 'approved',
  'green': 'approved',
  'blue': 'presentation',
  'light-blue': 'presentation',
  'grey': 'presentation',
  'yellow': 'uncertain',
  'orange': 'uncertain',
  'light-red': 'rejected',
  'red': 'rejected',
  'black': 'rejected',
}

export type RibbonSegment = {
  startLine: number
  endLine: number
  // Source file each endpoint anchors to ('' = main/bare-keyed file). Required to
  // disambiguate the same line number across \input files when remapping.
  startFile?: string
  endFile?: string
  status: LineStatus
  y1: number
  y2: number
  // Shadow-repo commit this span was vetted against. The span's line numbers are
  // relative to this commit, so on rebuild the server diffs it forward to decide
  // whether the underlying source moved (→ stale). Absent on pre-anchor segments.
  approvedAtCommit?: string
  // Set by the staleness check after a rebuild: the source under this span changed
  // since approvedAtCommit, so the vetting no longer covers what's there now.
  stale?: boolean
  // When the span first flipped stale (the build-ready time of the build that
  // introduced the change). Lets the inbox sort revalidation tasks by when they
  // went stale. Cleared when the span is re-approved / heals back to fresh.
  staleAt?: number
  // Optional provenance for MCP/server-side checks. Kept on each segment so a
  // trimmed survivor still says who checked it and why.
  checkedById?: string
  checkedByName?: string
  checkedAt?: number
  reason?: string
  method?: string
  taskId?: string
  eventId?: string
}

function StatusBadge({ status, arrow }: { status: LineStatus; arrow?: boolean }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 3,
    }}>
      {arrow && <span style={{ color: '#999', fontSize: 10 }}>→</span>}
      <span style={{
        background: STATUS_COLORS[status],
        color: '#fff',
        fontSize: 10,
        fontWeight: 600,
        padding: '1px 5px',
        borderRadius: 3,
        lineHeight: '14px',
        whiteSpace: 'nowrap',
      }}>
        {STATUS_LABELS[status]}
      </span>
    </span>
  )
}

export function formatCheckedAt(ts?: number): string | null {
  if (!ts) return null
  const diff = Date.now() - ts
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// The who-checked-what-why detail for a vetted span: who vetted it, when, by
// what method, and why. Provenance is optional — renders nothing when a span
// carries none (e.g. a plain human highlight on bare main).
export function ProvenanceDetail({ seg }: { seg: RibbonSegment }) {
  const when = formatCheckedAt(seg.checkedAt)
  const rows: { label: string; value: string }[] = []
  if (seg.checkedByName) rows.push({ label: 'by', value: seg.checkedByName + (when ? ` · ${when}` : '') })
  else if (when) rows.push({ label: 'when', value: when })
  if (seg.method) rows.push({ label: 'method', value: seg.method })
  if (seg.reason) rows.push({ label: 'why', value: seg.reason })
  if (seg.taskId) rows.push({ label: 'task', value: seg.taskId })
  if (!rows.length) return null
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      marginTop: 4,
      paddingTop: 4,
      borderTop: '1px solid rgba(255,255,255,0.15)',
      maxWidth: 240,
      whiteSpace: 'normal',
    }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 5, fontSize: 10, lineHeight: '13px' }}>
          <span style={{ color: 'rgba(255,255,255,0.5)', flexShrink: 0, minWidth: 34 }}>{r.label}</span>
          <span style={{ color: 'rgba(255,255,255,0.92)' }}>{r.value}</span>
        </div>
      ))}
    </div>
  )
}

function interpolatePath(d: string, targetX: number, t: number): string {
  const re = /([MQTLCS])([^MQTLCSAZ]*)/gi
  let result = ''
  let match
  while ((match = re.exec(d)) !== null) {
    const cmd = match[1]
    const nums = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number)
    const morphed = nums.map((v, i) => {
      if (i % 2 === 0) return v + (targetX - v) * t
      return v
    })
    result += cmd + morphed.join(',')
  }
  return result
}

const RIBBON_HIT_MARGIN = 20

export class UnderstandingLineShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'understanding-line' as const
  static override props = {
    w: T.number,
    h: T.number,
    segments: T.string,
  }
  getDefaultProps() {
    return { w: 6, h: 20, segments: '[]' }
  }

  override canEdit = () => false
  override canResize = () => false
  override canBind = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override hideResizeHandles = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  override getGeometry(shape: any) {
    return new Rectangle2d({ width: Math.max(shape.props.w, 6), height: shape.props.h, isFilled: false })
  }

  component(shape: any) {
    const editor = useEditor()
    const provMode = useProvenanceMode()
    const segments: RibbonSegment[] = (() => {
      try { return JSON.parse(shape.props.segments || '[]') }
      catch { return [] }
    })()

    const ghost = useValue('ribbon-ghost', () => {
      const toolId = editor.getCurrentToolId()
      if (toolId !== 'highlight') return null

      const point = editor.inputs.currentPagePoint
      if (point.x > shape.x + shape.props.w + RIBBON_HIT_MARGIN) return null
      if (point.x < shape.x - RIBBON_HIT_MARGIN) return null

      const color = (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || 'green'
      const status = HIGHLIGHT_TO_STATUS[color]
      if (!status) return null

      const isDrawing = editor.inputs.isDragging || editor.inputs.isPointing
      if (isDrawing) {
        const originY = editor.inputs.originPagePoint.y
        const currentY = point.y
        const minY = Math.min(originY, currentY)
        const maxY = Math.max(originY, currentY)
        const height = maxY - minY
        return {
          y1: Math.max(0, minY - shape.y),
          y2: Math.min(shape.props.h, maxY - shape.y),
          status,
          cursor: height < 3,
        }
      }

      return {
        y1: Math.max(0, point.y - shape.y - 4),
        y2: Math.min(shape.props.h, point.y - shape.y + 4),
        status,
        cursor: true,
      }
    }, [editor, shape])

    // Eraser preview: only ever the eraser head at the current pointer — never
    // an accumulated gesture extent. Accumulating min/max made the dimmed/erased
    // band grow with total cursor travel (and never shrink back), so the mark
    // looked like it was resizing down as you moved. The actual erase removes the
    // swept band live (setupRibbonEraser), so the head indicator is all we show.
    const ERASE_HEAD = 6
    const eraseRange = useValue('ribbon-erase-ghost', () => {
      const toolId = editor.getCurrentToolId()
      if (toolId !== 'eraser') return null

      const point = editor.inputs.currentPagePoint
      if (point.x > shape.x + shape.props.w + RIBBON_HIT_MARGIN) return null
      if (point.x < shape.x - RIBBON_HIT_MARGIN) return null

      return {
        y1: Math.max(0, point.y - shape.y - ERASE_HEAD),
        y2: Math.min(shape.props.h, point.y - shape.y + ERASE_HEAD),
      }
    }, [editor, shape])

    const hovered = useValue('uline-hovered', () =>
      editor.getHoveredShapeId() === shape.id, [editor, shape.id])

    const activeHighlightColor = useValue('active-hl-color', () => {
      const tool = editor.getCurrentToolId()
      if (tool !== 'highlight') return null
      return (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || null
    }, [editor])

    const pointerY = useValue('pointer-y', () =>
      editor.inputs.currentPagePoint.y, [editor])

    const hoveredSegment = hovered ? segments.find(seg => {
      const relY = pointerY - shape.y
      return relY >= seg.y1 && relY <= seg.y2
    }) : null

    const targetStatus = activeHighlightColor ? HIGHLIGHT_TO_STATUS[activeHighlightColor] : undefined

    type SuckInData = {
      pathD: string
      stroke: string
      strokeWidth: string
      shapeX: number
      shapeY: number
      ribbonY: number
      status: LineStatus
      t: number
    }
    const [suckIn, setSuckIn] = useState<SuckInData | null>(null)
    const suckInRef = useRef<SuckInData | null>(null)
    const rafRef = useRef<number>(0)

    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent).detail
        const data: SuckInData = { ...detail, t: 0 }
        suckInRef.current = data
        setSuckIn(data)

        const start = performance.now()
        const duration = 450
        const animate = (now: number) => {
          const t = Math.min(1, (now - start) / duration)
          const eased = 1 - Math.pow(1 - t, 3)
          const updated = { ...suckInRef.current!, t: eased }
          suckInRef.current = updated
          setSuckIn(updated)
          if (t < 1) rafRef.current = requestAnimationFrame(animate)
          else setTimeout(() => setSuckIn(null), 50)
        }
        cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(animate)
      }
      window.addEventListener('ribbon-suck-in', handler)
      return () => {
        window.removeEventListener('ribbon-suck-in', handler)
        cancelAnimationFrame(rafRef.current)
      }
    }, [])

    return (
      <HTMLContainer
        style={{
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        {/* Background track */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            backgroundColor: STATUS_COLORS.unchecked,
            borderRadius: 1,
            opacity: 0.1,
          }}
        />
        {/* Committed segments — split into pieces around erase zone */}
        {segments.filter(s => s.status !== 'unchecked').flatMap((seg, i) => {
          const color = STATUS_COLORS[seg.status] || STATUS_COLORS.unchecked
          // Stale spans (source moved since vetted) render dimmed with a faint
          // diagonal hatch so they read as "weakened — needs revalidation".
          // Provisional look, pending Skip's sign-off on the exact treatment.
          const staleStyle: React.CSSProperties = seg.stale
            ? { opacity: 0.3, backgroundImage: 'repeating-linear-gradient(45deg, rgba(130,130,130,0.5) 0, rgba(130,130,130,0.5) 1px, transparent 1px, transparent 3px)' }
            : { opacity: 0.5 }
          if (!eraseRange || seg.y2 <= eraseRange.y1 || seg.y1 >= eraseRange.y2) {
            return [(
              <div key={i} style={{
                position: 'absolute', left: 0, width: '100%',
                top: seg.y1, height: Math.max(2, seg.y2 - seg.y1),
                backgroundColor: color, borderRadius: 1, ...staleStyle,
              }} />
            )]
          }
          const parts: React.ReactElement[] = []
          if (seg.y1 < eraseRange.y1) {
            parts.push(<div key={`${i}-above`} style={{
              position: 'absolute', left: 0, width: '100%',
              top: seg.y1, height: eraseRange.y1 - seg.y1,
              backgroundColor: color, borderRadius: 1, ...staleStyle,
            }} />)
          }
          const overlapY1 = Math.max(seg.y1, eraseRange.y1)
          const overlapY2 = Math.min(seg.y2, eraseRange.y2)
          parts.push(<div key={`${i}-erase`} style={{
            position: 'absolute', left: 0, width: '100%',
            top: overlapY1, height: Math.max(2, overlapY2 - overlapY1),
            backgroundColor: color, opacity: 0.15, borderRadius: 1,
          }} />)
          if (seg.y2 > eraseRange.y2) {
            parts.push(<div key={`${i}-below`} style={{
              position: 'absolute', left: 0, width: '100%',
              top: eraseRange.y2, height: seg.y2 - eraseRange.y2,
              backgroundColor: color, borderRadius: 1, ...staleStyle,
            }} />)
          }
          return parts
        })}
        {/* Ghost preview while drawing / cursor indicator while hovering */}
        {ghost && (
          <div style={{
            position: 'absolute',
            left: 0,
            width: '100%',
            top: ghost.y1,
            height: Math.max(ghost.cursor ? 8 : 2, ghost.y2 - ghost.y1),
            backgroundColor: STATUS_COLORS[ghost.status] || STATUS_COLORS.unchecked,
            opacity: ghost.cursor ? 0.4 : 0.25,
            borderRadius: 1,
            transition: ghost.cursor ? 'none' : 'top 0.05s, height 0.05s',
          }} />
        )}
        {/* Erase ghost — shows the zone that would be cleared */}
        {eraseRange && (
          <div style={{
            position: 'absolute',
            left: 0,
            width: '100%',
            top: eraseRange.y1,
            height: Math.max(4, eraseRange.y2 - eraseRange.y1),
            backgroundColor: STATUS_COLORS.unchecked,
            opacity: 0.3,
            borderRadius: 1,
          }} />
        )}
        {/* Suck-in path morph animation */}
        {suckIn && (() => {
          const targetX = shape.props.w / 2
          const morphPath = interpolatePath(suckIn.pathD, targetX - suckIn.shapeX + shape.x, suckIn.t)
          const opacity = suckIn.t < 0.3 ? 0.5 : 0.5 * (1 - (suckIn.t - 0.3) / 0.7)
          return (
            <svg
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: shape.props.w,
                height: shape.props.h,
                overflow: 'visible',
                pointerEvents: 'none',
              }}
            >
              <g transform={`translate(${suckIn.shapeX - shape.x}, ${suckIn.shapeY - shape.y})`}>
                <path
                  d={morphPath}
                  stroke={suckIn.stroke || STATUS_COLORS[suckIn.status]}
                  strokeWidth={suckIn.strokeWidth || '8'}
                  fill="none"
                  opacity={Math.max(0, opacity)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            </svg>
          )
        })()}
        {/* Hover tooltip: status badge(s) on top, who-checked-what-why below. */}
        {provMode === 'hover' && hovered && hoveredSegment && (
          <div
            style={{
              position: 'absolute',
              left: 8,
              top: (hoveredSegment.y1 + hoveredSegment.y2) / 2,
              transform: 'translateY(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 3,
              background: 'rgba(30,30,30,0.95)',
              padding: '4px 7px',
              borderRadius: 4,
              pointerEvents: 'none',
              zIndex: 100,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
              {targetStatus && targetStatus !== hoveredSegment.status ? (
                <>
                  {hoveredSegment.status !== 'unchecked' && <StatusBadge status={hoveredSegment.status} />}
                  <StatusBadge status={targetStatus} arrow />
                </>
              ) : (
                <StatusBadge status={hoveredSegment.status} />
              )}
            </div>
            <ProvenanceDetail seg={hoveredSegment} />
          </div>
        )}
      </HTMLContainer>
    )
  }

  indicator() {
    return null as any
  }
}
