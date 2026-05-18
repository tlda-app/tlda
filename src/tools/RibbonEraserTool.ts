/**
 * RibbonEraserTool — custom eraser that handles locked understanding-line shapes.
 *
 * TLDraw's built-in eraser excludes locked shapes from hit testing entirely.
 * Understanding-line shapes are locked (to prevent selection/move interference),
 * but the eraser should reset them to 'unchecked' status instead of ignoring them.
 *
 * Approach: extend TLDraw's Erasing/Pointing child states to additionally track
 * understanding-line shapes the scribble passes over. On complete, those shapes
 * get their status reset to 'unchecked' (not deleted).
 */
import {
  StateNode,
  isAccelKey,
  pointInPolygon,
} from '@tldraw/editor'
import type {
  TLStateNodeConstructor,
  TLPointerEventInfo,
  TLShapeId,
} from '@tldraw/editor'
import { getHumanId } from '../fleet/fleet-data.mjs'

class RibbonEraserIdle extends StateNode {
  static override id = 'idle'

  override onPointerDown(info: TLPointerEventInfo) {
    this.parent.transition('pointing', info)
  }

  override onCancel() {
    this.editor.setCurrentTool('select')
  }
}

class RibbonEraserPointing extends StateNode {
  static override id = 'pointing'

  _isHoldingAccelKey = false

  override onEnter() {
    this._isHoldingAccelKey = isAccelKey(this.editor.inputs)

    const zoomLevel = this.editor.getZoomLevel()
    const currentPageShapesSorted = this.editor.getCurrentPageRenderingShapesSorted()
    const currentPagePoint = this.editor.inputs.getCurrentPagePoint()

    const erasing = new Set<TLShapeId>()
    const initialSize = erasing.size

    for (let n = currentPageShapesSorted.length, i = n - 1; i >= 0; i--) {
      const shape = currentPageShapesSorted[i]
      if (this.editor.isShapeOrAncestorLocked(shape) || this.editor.isShapeOfType(shape, 'group')) {
        continue
      }
      if (
        this.editor.isPointInShape(shape, currentPagePoint, {
          hitInside: false,
          margin: this.editor.options.hitTestMargin / zoomLevel,
        })
      ) {
        const hitShape = this.editor.getOutermostSelectableShape(shape)
        if (this.editor.isShapeOfType(hitShape, 'frame') && erasing.size > initialSize) break
        erasing.add(hitShape.id)
        if (this._isHoldingAccelKey) break
      }
    }

    this.editor.setErasingShapes([...erasing])

    // Point-erase understanding-line shapes in the ribbon zone
    if (currentPagePoint.x < 10) {
      const userId = getHumanId()
      if (userId) {
        for (const shape of this.editor.getCurrentPageShapes()) {
          if (shape.type !== 'understanding-line') continue
          const p = shape.props as Record<string, unknown>
          if (p.userId !== userId || p.status === 'unchecked') continue
          const bounds = this.editor.getShapePageBounds(shape.id)
          if (!bounds) continue
          if (currentPagePoint.y >= bounds.minY && currentPagePoint.y <= bounds.maxY) {
            ;(this.parent as RibbonEraserTool)._ribbonShapesToReset.add(shape.id)
          }
        }
      }
    }
  }

  override onKeyUp() { this._isHoldingAccelKey = isAccelKey(this.editor.inputs) }
  override onKeyDown() { this._isHoldingAccelKey = isAccelKey(this.editor.inputs) }

  override onLongPress(info: TLPointerEventInfo) {
    this.parent.transition('erasing', info)
  }

  override onExit(_info: any, to: string) {
    if (to !== 'erasing') {
      this.editor.setErasingShapes([])
    }
  }

  override onPointerMove(info: TLPointerEventInfo) {
    if (this._isHoldingAccelKey) return
    if (this.editor.inputs.getIsDragging()) {
      this.parent.transition('erasing', info)
    }
  }

  override onPointerUp() { this.complete() }
  override onCancel() { this.cancel() }
  override onComplete() { this.complete() }
  override onInterrupt() { this.cancel() }

  complete() {
    const erasingShapeIds = this.editor.getErasingShapeIds()
    if (erasingShapeIds.length) {
      this.editor.markHistoryStoppingPoint('erase end')
      this.editor.deleteShapes(erasingShapeIds)
    }

    // Reset ribbon shapes to unchecked
    const tool = this.parent as RibbonEraserTool
    if (tool._ribbonShapesToReset.size > 0) {
      for (const id of tool._ribbonShapesToReset) {
        const shape = this.editor.getShape(id)
        if (!shape) continue
        const p = shape.props as Record<string, unknown>
        this.editor.store.update(shape.id, (s: any) => ({
          ...s,
          props: { ...s.props, status: 'unchecked' },
        }))
      }
      tool._ribbonShapesToReset.clear()
    }

    this.parent.transition('idle')
  }

  cancel() {
    (this.parent as RibbonEraserTool)._ribbonShapesToReset.clear()
    this.parent.transition('idle')
  }
}

class RibbonErasing extends StateNode {
  static override id = 'erasing'

  private info = {} as TLPointerEventInfo
  private scribbleId = 'id'
  private markId = ''
  private excludedShapeIds = new Set<TLShapeId>()

  _isHoldingAccelKey = false
  _firstErasingShapeId: TLShapeId | null = null
  _erasingShapeIds: TLShapeId[] = []

  override onEnter(info: TLPointerEventInfo) {
    this._isHoldingAccelKey = isAccelKey(this.editor.inputs)
    this._firstErasingShapeId = this.editor.getErasingShapeIds()[0]
    this._erasingShapeIds = this.editor.getErasingShapeIds()

    this.markId = this.editor.markHistoryStoppingPoint('erase scribble begin')
    this.info = info

    const originPagePoint = this.editor.inputs.getOriginPagePoint()
    this.excludedShapeIds = new Set(
      this.editor
        .getCurrentPageShapes()
        .filter((shape) => {
          if (this.editor.isShapeOrAncestorLocked(shape)) return true
          if (
            this.editor.isShapeOfType(shape, 'group') ||
            this.editor.isShapeOfType(shape, 'frame')
          ) {
            const pointInShapeShape = this.editor.getPointInShapeSpace(shape, originPagePoint)
            const geometry = this.editor.getShapeGeometry(shape)
            return geometry.bounds.containsPoint(pointInShapeShape)
          }
          return false
        })
        .map((shape) => shape.id)
    )

    const scribble = this.editor.scribbles.addScribble({
      color: 'muted-1',
      size: 12,
    })
    this.scribbleId = scribble.id

    this.update()
  }

  private pushPointToScribble() {
    const { x, y } = this.editor.inputs.getCurrentPagePoint()
    this.editor.scribbles.addPoint(this.scribbleId, x, y)
  }

  override onExit() {
    this.editor.setErasingShapes([])
    this.editor.scribbles.stop(this.scribbleId)
  }

  override onPointerMove() { this.update() }
  override onPointerUp() { this.complete() }
  override onCancel() { this.cancel() }
  override onComplete() { this.complete() }
  override onKeyUp() { this._isHoldingAccelKey = isAccelKey(this.editor.inputs); this.update() }
  override onKeyDown() { this._isHoldingAccelKey = isAccelKey(this.editor.inputs); this.update() }

  update() {
    const { editor, excludedShapeIds } = this
    const erasingShapeIds = editor.getErasingShapeIds()
    const zoomLevel = editor.getZoomLevel()
    const currentPageShapes = editor.getCurrentPageRenderingShapesSorted()
    const currentPagePoint = editor.inputs.getCurrentPagePoint()
    const previousPagePoint = editor.inputs.getPreviousPagePoint()

    this.pushPointToScribble()

    const erasing = new Set<TLShapeId>(erasingShapeIds)
    const minDist = this.editor.options.hitTestMargin / zoomLevel

    for (const shape of currentPageShapes) {
      if (editor.isShapeOfType(shape, 'group')) continue
      const pageMask = editor.getShapeMask(shape.id)
      if (pageMask && !pointInPolygon(currentPagePoint, pageMask)) continue

      const geometry = editor.getShapeGeometry(shape)
      const pageTransform = editor.getShapePageTransform(shape)
      if (!geometry || !pageTransform) continue
      const pt = pageTransform.clone().invert()
      const A = pt.applyToPoint(previousPagePoint)
      const B = pt.applyToPoint(currentPagePoint)

      const { bounds } = geometry
      if (
        bounds.minX - minDist > Math.max(A.x, B.x) ||
        bounds.minY - minDist > Math.max(A.y, B.y) ||
        bounds.maxX + minDist < Math.min(A.x, B.x) ||
        bounds.maxY + minDist < Math.min(A.y, B.y)
      ) {
        continue
      }

      if (geometry.hitTestLineSegment(A, B, minDist)) {
        erasing.add(editor.getOutermostSelectableShape(shape).id)
      }

      this._erasingShapeIds = [...erasing]
    }

    if (this._isHoldingAccelKey && this._firstErasingShapeId) {
      if (this._firstErasingShapeId && this.editor.getShape(this._firstErasingShapeId)) {
        editor.setErasingShapes([this._firstErasingShapeId])
      }
      return
    }

    this.editor.setErasingShapes(this._erasingShapeIds.filter((id) => !excludedShapeIds.has(id)))

    // Track understanding-line shapes the scribble passes over in the ribbon zone
    if (currentPagePoint.x < 10) {
      const userId = getHumanId()
      if (userId) {
        const tool = this.parent as RibbonEraserTool
        for (const shape of this.editor.getCurrentPageShapes()) {
          if (shape.type !== 'understanding-line') continue
          const p = shape.props as Record<string, unknown>
          if (p.userId !== userId || p.status === 'unchecked') continue
          const bounds = this.editor.getShapePageBounds(shape.id)
          if (!bounds) continue
          if (currentPagePoint.y >= bounds.minY && currentPagePoint.y <= bounds.maxY &&
              currentPagePoint.x <= bounds.maxX + 5) {
            tool._ribbonShapesToReset.add(shape.id)
          }
        }
      }
    }
  }

  complete() {
    const { editor } = this
    editor.deleteShapes(editor.getCurrentPageState().erasingShapeIds)

    // Reset ribbon shapes to unchecked
    const tool = this.parent as RibbonEraserTool
    if (tool._ribbonShapesToReset.size > 0) {
      for (const id of tool._ribbonShapesToReset) {
        const shape = editor.getShape(id)
        if (!shape) continue
        const p = shape.props as Record<string, unknown>
        editor.store.update(shape.id, (s: any) => ({
          ...s,
          props: { ...s.props, status: 'unchecked' },
        }))
      }
      tool._ribbonShapesToReset.clear()
    }

    this.parent.transition('idle')
    this._erasingShapeIds = []
    this._firstErasingShapeId = null
  }

  cancel() {
    this.editor.bailToMark(this.markId)
    ;(this.parent as RibbonEraserTool)._ribbonShapesToReset.clear()
    this.parent.transition('idle', this.info)
  }
}

export class RibbonEraserTool extends StateNode {
  static override id = 'eraser'
  static override initial = 'idle'
  static override isLockable = false
  static override children(): TLStateNodeConstructor[] {
    return [RibbonEraserIdle, RibbonEraserPointing, RibbonErasing]
  }

  _ribbonShapesToReset = new Set<TLShapeId>()

  override onEnter() {
    this.editor.setCursor({ type: 'cross', rotation: 0 })
  }
}
