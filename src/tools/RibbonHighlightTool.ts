/**
 * RibbonHighlightTool — custom highlight tool with ribbon-zone hover.
 *
 * Extends TLDraw's HighlightShapeTool to set hoveredShapeId for locked
 * understanding-line shapes when the pointer is in the ribbon hit strip.
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
import { log } from '../logger'
import { ribbonPageHitStrip } from '../shapes/ribbon-geometry'

// Extract the original Drawing class from the HighlightShapeTool's children
const OriginalChildren = HighlightShapeTool.children!()
const DrawingState = OriginalChildren.find(c => c.id === 'drawing')!

class RibbonHighlightIdle extends StateNode {
  static override id = 'idle'

  private _precedingEvent: {
    name: 'enter' | 'pointer-down' | 'pointer-move'
    at: number
    pagePoint: { x: number; y: number }
    screenPoint: { x: number; y: number }
    isPointing: boolean
    isDragging: boolean
  } | null = null

  private _recordEvent(name: 'enter' | 'pointer-down' | 'pointer-move') {
    const pagePoint = this.editor.inputs.getCurrentPagePoint()
    const screenPoint = this.editor.inputs.getCurrentScreenPoint()
    this._precedingEvent = {
      name,
      at: Date.now(),
      pagePoint: { x: pagePoint.x, y: pagePoint.y },
      screenPoint: { x: screenPoint.x, y: screenPoint.y },
      isPointing: this.editor.inputs.isPointing,
      isDragging: this.editor.inputs.isDragging,
    }
  }

  override onPointerDown(info: TLPointerEventInfo) {
    this._recordEvent('pointer-down')
    this.parent.transition('drawing', info)
  }

  override onEnter() {
    this._recordEvent('enter')
    this.editor.setCursor({ type: 'cross', rotation: 0 })
  }

  override onPointerMove() {
    this._recordEvent('pointer-move')
    this._updateRibbonHover()
  }

  override onCancel() {
    const pagePoint = this.editor.inputs.getCurrentPagePoint()
    const screenPoint = this.editor.inputs.getCurrentScreenPoint()
    log.metric('ribbon-highlight-telemetry', 'idle onCancel switched tool', {
      at: Date.now(),
      currentTool: this.editor.getCurrentToolId(),
      pagePoint: { x: pagePoint.x, y: pagePoint.y },
      screenPoint: { x: screenPoint.x, y: screenPoint.y },
      isPointing: this.editor.inputs.isPointing,
      isDragging: this.editor.inputs.isDragging,
      precedingEvent: this._precedingEvent,
    })
    this.editor.setCurrentTool('select')
  }

  private _lastRibbonHover = false

  private _updateRibbonHover() {
    const point = this.editor.inputs.getCurrentPagePoint()
    const strip = ribbonPageHitStrip(this.editor.getZoomLevel())
    if (point.x < strip.minX || point.x > strip.maxX) {
      if (this._lastRibbonHover) {
        this.editor.setHoveredShape(null)
        this._lastRibbonHover = false
      }
      return
    }

    let best: { shape: TLShape; area: number } | null = null
    for (const s of this.editor.getCurrentPageShapes()) {
      if ((s.type as string) !== 'understanding-line') continue
      const bounds = this.editor.getShapePageBounds(s.id)
      if (!bounds) continue
      if (point.y < bounds.minY || point.y > bounds.maxY) continue
      if (point.x < bounds.minX - 5 || point.x > bounds.maxX + 5) continue
      const area = bounds.width * bounds.height
      if (!best || area < best.area) best = { shape: s, area }
    }
    if (best) {
      this.editor.setHoveredShape(best.shape.id)
      this._lastRibbonHover = true
    } else if (this._lastRibbonHover) {
      this.editor.setHoveredShape(null)
      this._lastRibbonHover = false
    }
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
    this.editor.setHoveredShape(null)
    const drawingState = this.children!['drawing'] as any
    drawingState.initialShape = undefined
  }
}
