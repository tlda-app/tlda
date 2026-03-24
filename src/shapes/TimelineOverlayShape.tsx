/**
 * TimelineOverlayShape — spatial timeline showing document activity over time.
 *
 * Single shape rendering a 2D scatter chart:
 *   X axis = time (left = oldest, right = now)
 *   Y axis = document position (top = page 1, bottom = last page)
 *
 * Event types:
 *   - build: changelog build entries (tex changes)
 *   - annotation: shape creation events (notes, highlights)
 *
 * Visual encoding:
 *   - Dot size = significance (# changed pages for builds, always small for annotations)
 *   - Dot color = event type
 *   - Document envelope = page count over time (filled area)
 *   - Section labels on Y axis
 *
 * Click dot → scrolls doc to that page + scrubs fleet playback to that time.
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  stopEventPropagation,
} from 'tldraw'
import { useCallback, useRef, useEffect, useState, useMemo } from 'react'

// Event types and their colors
const EVENT_COLORS: Record<string, string> = {
  build: '#f59e0b',       // amber — builds
  annotation: '#6366f1',  // indigo — annotations
  highlight: '#10b981',   // emerald — highlights
  comment: '#8b5cf6',     // violet — comments/notes
}

const AXIS_COLOR = 'rgba(148, 163, 184, 0.4)'  // slate-400 at 40%
const LABEL_COLOR = 'rgba(148, 163, 184, 0.6)'
const ENVELOPE_FILL = 'rgba(59, 130, 246, 0.06)' // blue at 6%
const ENVELOPE_STROKE = 'rgba(59, 130, 246, 0.15)'
const HOVER_RING = 'rgba(255, 255, 255, 0.8)'
const BG = 'rgba(15, 23, 42, 0.85)' // slate-900 at 85%

export interface TimelineEvent {
  ts: number
  type: 'build' | 'annotation' | 'highlight' | 'comment'
  page: number       // primary page (Y position)
  pages?: number[]   // all affected pages
  significance: number  // 0–1, maps to dot size
  label?: string     // tooltip text
  buildHash?: string
}

export interface TimelineSection {
  label: string
  startPage: number
}

export interface TimelineData {
  events: TimelineEvent[]
  sections: TimelineSection[]
  totalPages: number
  timeRange: { min: number; max: number }
}

export class TimelineOverlayShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'timeline-overlay' as const
  static override props = {
    w: T.number,
    h: T.number,
  }

  getDefaultProps() {
    return { w: 520, h: 400 }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override isAspectRatioLocked = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <TimelineOverlayComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}

// ─── Component ──────────────────────────────────────────

function TimelineOverlayComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const svgRef = useRef<SVGSVGElement>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [data, setData] = useState<TimelineData | null>(null)

  // Read timeline data from shape meta (set by the hook)
  useEffect(() => {
    const meta = shape.meta as any
    if (meta?.timelineData) {
      setData(meta.timelineData)
    }
  }, [shape.meta])

  const W = shape.props.w
  const H = shape.props.h
  const PAD = { top: 24, right: 20, bottom: 40, left: 56 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom

  const { dots, envelope, sectionLabels, timeLabels } = useMemo(() => {
    if (!data || data.events.length === 0) {
      return { dots: [], envelope: '', sectionLabels: [], timeLabels: [] }
    }

    const { events, sections, totalPages, timeRange } = data
    const tMin = timeRange.min
    const tMax = timeRange.max
    const tSpan = Math.max(tMax - tMin, 1)

    // Map time → x, page → y
    const tx = (t: number) => PAD.left + ((t - tMin) / tSpan) * plotW
    const py = (p: number) => PAD.top + ((p - 1) / Math.max(totalPages - 1, 1)) * plotH

    // Build dots
    const dotData = events.map((ev, i) => ({
      cx: tx(ev.ts),
      cy: py(ev.page),
      r: 3 + ev.significance * 6,  // 3–9px radius
      fill: EVENT_COLORS[ev.type] || EVENT_COLORS.annotation,
      ev,
      idx: i,
    }))

    // Document envelope — page count over time from build events
    const builds = events
      .filter(e => e.type === 'build')
      .sort((a, b) => a.ts - b.ts)

    let envPath = ''
    if (builds.length > 1) {
      // Build envelope: max page affected at each build timestamp
      const maxPages = builds.map(b => Math.max(...(b.pages || [b.page])))
      const points = builds.map((b, i) => `${tx(b.ts)},${py(maxPages[i])}`)
      // Close envelope: go back along bottom (page 1 line)
      const topLine = builds.map(b => `${tx(b.ts)},${py(1)}`).reverse()
      envPath = `M${topLine.join(' L')} L${points.join(' L')} Z`
    }

    // Section labels on Y axis
    const secLabels = sections.map(s => ({
      y: py(s.startPage),
      label: s.label,
    }))

    // Time axis labels
    const tLabels: Array<{ x: number; label: string }> = []
    const labelCount = Math.min(5, Math.max(2, Math.floor(plotW / 80)))
    for (let i = 0; i < labelCount; i++) {
      const t = tMin + (tSpan * i) / (labelCount - 1)
      const d = new Date(t)
      const label = formatTimeLabel(d, tSpan)
      tLabels.push({ x: tx(t), label })
    }

    return { dots: dotData, envelope: envPath, sectionLabels: secLabels, timeLabels: tLabels }
  }, [data, W, H])

  const handleDotClick = useCallback((ev: TimelineEvent) => {
    // Scroll document to the event's page
    const pageShapes = editor.getCurrentPageShapes().filter(
      (s: any) => s.type === 'svg-page' || s.type === 'html-page'
    )
    const sorted = [...pageShapes].sort((a, b) => a.y - b.y)
    const targetPage = sorted[ev.page - 1]
    if (targetPage) {
      ;(editor as any).zoomToShape(targetPage.id, { animation: { duration: 300 } })
    }

    // Scrub fleet playback to this timestamp
    try {
      const channel = new BroadcastChannel('fleet-playback')
      channel.postMessage({
        ts: ev.ts,
        playing: true,
        speed: 1,
        sessionId: 'timeline-scrub',
      })
      channel.close()
    } catch {
      // BroadcastChannel not available
    }
  }, [editor])

  if (!data) {
    return (
      <HTMLContainer>
        <div
          style={{
            width: W, height: H,
            background: BG, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: LABEL_COLOR, fontSize: 13, fontFamily: 'Inter, system-ui, sans-serif',
          }}
          onPointerDown={e => stopEventPropagation(e)}
        >
          Loading timeline…
        </div>
      </HTMLContainer>
    )
  }

  if (data.events.length === 0) {
    return (
      <HTMLContainer>
        <div
          style={{
            width: W, height: H,
            background: BG, borderRadius: 8,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: LABEL_COLOR, fontSize: 13, fontFamily: 'Inter, system-ui, sans-serif',
          }}
          onPointerDown={e => stopEventPropagation(e)}
        >
          No events yet
        </div>
      </HTMLContainer>
    )
  }

  return (
    <HTMLContainer>
      <div
        style={{
          width: W, height: H,
          background: BG, borderRadius: 8,
          overflow: 'hidden',
        }}
        onPointerDown={e => stopEventPropagation(e)}
      >
        <svg
          ref={svgRef}
          width={W}
          height={H}
          style={{ display: 'block' }}
        >
          {/* Document envelope */}
          {envelope && (
            <path d={envelope} fill={ENVELOPE_FILL} stroke={ENVELOPE_STROKE} strokeWidth={1} />
          )}

          {/* Y axis (page position) */}
          <line
            x1={PAD.left} y1={PAD.top}
            x2={PAD.left} y2={PAD.top + plotH}
            stroke={AXIS_COLOR} strokeWidth={1}
          />

          {/* X axis (time) */}
          <line
            x1={PAD.left} y1={PAD.top + plotH}
            x2={PAD.left + plotW} y2={PAD.top + plotH}
            stroke={AXIS_COLOR} strokeWidth={1}
          />

          {/* Section labels on Y axis */}
          {sectionLabels.map((s, i) => (
            <g key={`sec-${i}`}>
              <line
                x1={PAD.left - 4} y1={s.y}
                x2={PAD.left} y2={s.y}
                stroke={AXIS_COLOR} strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={s.y + 4}
                textAnchor="end"
                fill={LABEL_COLOR}
                fontSize={9}
                fontFamily="Inter, system-ui, sans-serif"
              >
                {truncate(s.label, 8)}
              </text>
            </g>
          ))}

          {/* Time labels on X axis */}
          {timeLabels.map((t, i) => (
            <g key={`time-${i}`}>
              <line
                x1={t.x} y1={PAD.top + plotH}
                x2={t.x} y2={PAD.top + plotH + 4}
                stroke={AXIS_COLOR} strokeWidth={1}
              />
              <text
                x={t.x}
                y={PAD.top + plotH + 16}
                textAnchor="middle"
                fill={LABEL_COLOR}
                fontSize={9}
                fontFamily="Inter, system-ui, sans-serif"
              >
                {t.label}
              </text>
            </g>
          ))}

          {/* Event dots */}
          {dots.map((d, i) => (
            <circle
              key={i}
              cx={d.cx}
              cy={d.cy}
              r={hoveredIdx === i ? d.r + 2 : d.r}
              fill={d.fill}
              opacity={hoveredIdx === i ? 1 : 0.7}
              stroke={hoveredIdx === i ? HOVER_RING : 'none'}
              strokeWidth={hoveredIdx === i ? 1.5 : 0}
              style={{ cursor: 'pointer', transition: 'r 0.15s, opacity 0.15s' }}
              onPointerEnter={() => setHoveredIdx(i)}
              onPointerLeave={() => setHoveredIdx(null)}
              onPointerDown={(e) => {
                stopEventPropagation(e)
                handleDotClick(d.ev)
              }}
            >
              {d.ev.label && <title>{d.ev.label}</title>}
            </circle>
          ))}

          {/* Hovered dot tooltip */}
          {hoveredIdx !== null && dots[hoveredIdx] && (
            <g>
              <rect
                x={Math.min(dots[hoveredIdx].cx + 10, W - 140)}
                y={dots[hoveredIdx].cy - 24}
                width={130}
                height={20}
                rx={4}
                fill="rgba(0,0,0,0.8)"
              />
              <text
                x={Math.min(dots[hoveredIdx].cx + 14, W - 136)}
                y={dots[hoveredIdx].cy - 10}
                fill="#e2e8f0"
                fontSize={10}
                fontFamily="Inter, system-ui, sans-serif"
              >
                {dots[hoveredIdx].ev.label || `p.${dots[hoveredIdx].ev.page} — ${dots[hoveredIdx].ev.type}`}
              </text>
            </g>
          )}

          {/* Legend */}
          {renderLegend(W)}
        </svg>
      </div>
    </HTMLContainer>
  )
}

function renderLegend(W: number) {
  const items = [
    { color: EVENT_COLORS.build, label: 'build' },
    { color: EVENT_COLORS.annotation, label: 'note' },
    { color: EVENT_COLORS.highlight, label: 'highlight' },
  ]
  const startX = W - 12 - items.length * 56
  return (
    <g>
      {items.map((item, i) => (
        <g key={item.label} transform={`translate(${startX + i * 56}, 10)`}>
          <circle cx={0} cy={0} r={3} fill={item.color} opacity={0.8} />
          <text x={7} y={3} fill={LABEL_COLOR} fontSize={9} fontFamily="Inter, system-ui, sans-serif">
            {item.label}
          </text>
        </g>
      ))}
    </g>
  )
}

// ─── Helpers ──────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function formatTimeLabel(d: Date, spanMs: number): string {
  if (spanMs > 7 * 86400_000) {
    // > 1 week: show date
    return `${d.getMonth() + 1}/${d.getDate()}`
  }
  if (spanMs > 86400_000) {
    // > 1 day: show day + time
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  // Same day: show time
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
