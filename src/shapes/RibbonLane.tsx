import { useEditor, useValue } from 'tldraw'
import { useState, useCallback } from 'react'
import { STATUS_COLORS, HIGHLIGHT_TO_STATUS } from './UnderstandingLineShape'
import type { LineStatus } from './UnderstandingLineShape'

const LANE_X = 0
const LANE_WIDTH = 3
const HIT_WIDTH = 14

export function RibbonLane() {
  const editor = useEditor()
  const [tooltipY, setTooltipY] = useState<number | null>(null)

  const style = useValue('ribbon-lane-style', () => {
    const pageShapes = editor.getCurrentPageShapes().filter((s: any) => s.type === 'svg-page')
    if (pageShapes.length === 0) return null

    let minY = Infinity, maxY = -Infinity
    for (const s of pageShapes) {
      const b = editor.getShapePageBounds(s.id)
      if (!b) continue
      if (b.minY < minY) minY = b.minY
      if (b.maxY > maxY) maxY = b.maxY
    }
    if (minY === Infinity) return null

    const topLeft = editor.pageToScreen({ x: LANE_X, y: minY })
    const bottomRight = editor.pageToScreen({ x: LANE_X + LANE_WIDTH, y: maxY })

    const width = bottomRight.x - topLeft.x
    const height = bottomRight.y - topLeft.y
    if (width < 1 || height < 1) return null

    return {
      left: topLeft.x,
      top: topLeft.y,
      width,
      height,
    }
  }, [editor])

  const activeHighlightColor = useValue('lane-hl-color', () => {
    const tool = editor.getCurrentToolId()
    if (tool !== 'highlight') return null
    return (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || null
  }, [editor])

  const targetStatus = activeHighlightColor ? HIGHLIGHT_TO_STATUS[activeHighlightColor] : undefined

  const isOverUnderstandingLine = useCallback((screenY: number) => {
    const pagePoint = editor.screenToPage({ x: 1, y: screenY })
    const margin = 5
    for (const s of editor.getCurrentPageShapes()) {
      if ((s.type as string) !== 'understanding-line') continue
      const bounds = editor.getShapePageBounds(s.id)
      if (!bounds) continue
      if (pagePoint.y >= bounds.minY - margin && pagePoint.y <= bounds.maxY + margin) return true
    }
    return false
  }, [editor])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (isOverUnderstandingLine(e.clientY)) {
      setTooltipY(null)
    } else {
      setTooltipY(e.clientY)
    }
  }, [isOverUnderstandingLine])

  const onMouseLeave = useCallback(() => setTooltipY(null), [])

  if (!style) return null

  const showTooltip = tooltipY !== null && targetStatus && targetStatus !== 'unchecked'

  return (
    <>
      <div
        className="ribbon-lane"
        style={{
          position: 'fixed',
          left: style.left,
          top: style.top,
          width: style.width,
          height: style.height,
          borderRadius: 1,
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      {/* Wider invisible hit area for hover detection */}
      <div
        style={{
          position: 'fixed',
          left: style.left,
          top: style.top,
          width: HIT_WIDTH,
          height: style.height,
          pointerEvents: 'auto',
          zIndex: 0,
          cursor: 'default',
        }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      />
      {showTooltip && (
        <div
          style={{
            position: 'fixed',
            left: (style.left ?? 0) + 8,
            top: tooltipY,
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            background: 'rgba(30,30,30,0.9)',
            padding: '3px 6px',
            borderRadius: 4,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            zIndex: 100,
          }}
        >
          <StatusBadge status={targetStatus!} />
        </div>
      )}
    </>
  )
}

function StatusBadge({ status, arrow }: { status: LineStatus; arrow?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
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
        {status}
      </span>
    </span>
  )
}
