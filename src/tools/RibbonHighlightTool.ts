/**
 * RibbonHighlightTool — custom highlight tool with ribbon-zone hover.
 *
 * Extends TLDraw's HighlightShapeTool to set hoveredShapeId for locked
 * understanding-line shapes when the pointer is in the ribbon zone (x < 10).
 * This enables the transition tooltip in the UnderstandingLineShape component
 * to show what status the highlight would set.
 *
 * Drawing behavior is unchanged — the existing afterCreate handler in
 * editorSetup.ts converts ribbon-zone highlights into status changes.
 */
import { StateNode } from '@tldraw/editor'
import type {
  TLStateNodeConstructor,
  TLPointerEventInfo,
  TLShape,
} from '@tldraw/editor'
import { HighlightShapeTool } from 'tldraw'

// Extract the original Drawing class from the HighlightShapeTool's children
const OriginalChildren = HighlightShapeTool.children!()
const DrawingState = OriginalChildren.find(c => c.id === 'drawing')!

class RibbonHighlightIdle extends StateNode {
  static override id = 'idle'

  override onPointerDown(info: TLPointerEventInfo) {
    this.parent.transition('drawing', info)
  }

  override onEnter() {
    this.editor.setCursor({ type: 'cross', rotation: 0 })
  }

  override onPointerMove() {
    this._updateRibbonHover()
  }

  override onCancel() {
    this.editor.setCurrentTool('select')
  }

  private _updateRibbonHover() {
    const point = this.editor.inputs.getCurrentPagePoint()
    if (point.x >= 10) return

    let best: { shape: TLShape; area: number } | null = null
    for (const s of this.editor.getCurrentPageShapes()) {
      if (s.type !== 'understanding-line') continue
      const bounds = this.editor.getShapePageBounds(s.id)
      if (!bounds) continue
      if (point.y < bounds.minY || point.y > bounds.maxY) continue
      if (point.x < bounds.minX - 5 || point.x > bounds.maxX + 5) continue
      const area = bounds.width * bounds.height
      if (!best || area < best.area) best = { shape: s, area }
    }
    if (best) this.editor.setHoveredShape(best.shape.id)
  }
}

export class RibbonHighlightTool extends StateNode {
  static override id = 'highlight'
  static override initial = 'idle'
  static override useCoalescedEvents = true
  static override children(): TLStateNodeConstructor[] {
    return [RibbonHighlightIdle, DrawingState]
  }
  static override isLockable = false
  override shapeType = 'highlight'

  override onExit() {
    const drawingState = this.children!['drawing'] as any
    drawingState.initialShape = undefined
  }
}
