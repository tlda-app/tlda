/**
 * RibbonLane — persistent gray strip in the left margin of the document.
 *
 * Always visible, spanning the full height of all pages. Provides the visual
 * context that makes understanding-line shapes feel like a ribbon rather than
 * isolated shapes. The lane itself is purely decorative — it renders behind
 * the existing understanding-line shapes.
 *
 * Renders inside InFrontOfTheCanvas. Derives page bounds reactively from
 * svg-page shapes in the editor (not currentDocumentInfo, which is not reactive).
 * Uses editor.pageToScreen() to stay in sync with camera pan/zoom.
 */

import { useEditor, useValue } from 'tldraw'

// Canvas-space bounds for the ribbon lane, relative to page left edge (x=0)
const LANE_LEFT = -30   // canvas units left of x=0
const LANE_RIGHT = -2   // canvas units (stays clear of page edge)

export function RibbonLane() {
  const editor = useEditor()

  const style = useValue('ribbon-lane-style', () => {
    // Derive page extents reactively from svg-page shapes
    const pageShapes = editor.getCurrentPageShapes().filter((s: any) => s.type === 'svg-page')
    if (pageShapes.length === 0) return null

    // Find the topmost and bottommost Y extents
    let minY = Infinity, maxY = -Infinity
    for (const s of pageShapes) {
      const b = editor.getShapePageBounds(s.id)
      if (!b) continue
      if (b.minY < minY) minY = b.minY
      if (b.maxY > maxY) maxY = b.maxY
    }
    if (minY === Infinity) return null

    const topLeft = editor.pageToScreen({ x: LANE_LEFT, y: minY })
    const bottomRight = editor.pageToScreen({ x: LANE_RIGHT, y: maxY })

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
        background: 'rgba(150,150,150,0.1)',
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  )
}
