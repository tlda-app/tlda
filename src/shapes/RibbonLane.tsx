/**
 * RibbonLane — thin gray line in the left margin spanning the full document height.
 *
 * This is the "unchecked" default — the visual base that understanding-line shapes
 * render on top of. Its width matches understanding-line segments so the whole
 * thing reads as one continuous ribbon that changes color where status is set.
 */

import { useEditor, useValue } from 'tldraw'

const LANE_X = -12
const LANE_WIDTH = 3

export function RibbonLane() {
  const editor = useEditor()

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

  if (!style) return null

  return (
    <div
      style={{
        position: 'fixed',
        left: style.left,
        top: style.top,
        width: style.width,
        height: style.height,
        background: 'rgba(150,150,150,0.3)',
        borderRadius: 1,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  )
}
