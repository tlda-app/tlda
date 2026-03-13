import { StateNode, Vec, EASINGS, type TLClickEventInfo, type TLStateNodeConstructor } from 'tldraw'

const AXIS_THRESHOLD = 5 // px before locking axis

/** Find the actual text content bounds within an SVG page shape.
 *  Queries the DOM for text elements and returns their x-range in page coordinates.
 *  Falls back to full page bounds if no text found. */
function getContentBounds(shapeId: string, pageBounds: { minX: number; minY: number; width: number; height: number }) {
  try {
    const el = document.querySelector(`[data-shape-id="${shapeId}"]:not(.tl-shape-background)`)
    const svg = el?.querySelector('svg')
    if (!svg) return pageBounds

    const viewBox = svg.viewBox?.baseVal
    if (!viewBox || viewBox.width === 0) return pageBounds

    const texts = svg.querySelectorAll('text')
    if (texts.length === 0) return pageBounds

    let minX = Infinity, maxX = -Infinity
    for (const t of texts) {
      if (t.closest('defs')) continue
      const x = parseFloat(t.getAttribute('x') || '0')
      const len = (t as SVGTextContentElement).getComputedTextLength?.() || 0
      if (x < minX) minX = x
      if (x + len > maxX) maxX = x + len
    }

    if (minX >= maxX) return pageBounds

    // Convert from SVG viewBox coords to page coords
    const scaleX = pageBounds.width / viewBox.width
    const pageMinX = pageBounds.minX + minX * scaleX
    const pageMaxX = pageBounds.minX + maxX * scaleX

    return { minX: pageMinX, minY: pageBounds.minY, width: pageMaxX - pageMinX, height: pageBounds.height }
  } catch {
    return pageBounds
  }
}

/**
 * Phone hand tool: 1-finger scroll with axis snapping.
 *
 * - Drag starts unlocked; after AXIS_THRESHOLD px, locks to dominant axis
 * - Locked axis zeroes out the other delta
 * - Momentum slide is also axis-locked
 * - Double/triple/quad tap zoom inherited from HandTool behavior
 */
export class PhoneHandTool extends StateNode {
  static override id = 'phone-hand'
  static override initial = 'idle'
  static override isLockable = false
  static override children(): TLStateNodeConstructor[] {
    return [PhoneIdle, PhonePointing, PhoneDragging]
  }

  override onDoubleClick(info: TLClickEventInfo) {
    if (info.phase === 'settle') {
      const pt = this.editor.inputs.getCurrentScreenPoint()
      const pagePt = this.editor.screenToPage(pt)
      // Smart zoom: find the svg-page at tap point and zoom to fit its width
      const pageShape = this.editor.getCurrentPageShapes().find(s => {
        if (s.type !== 'svg-page') return false
        const b = this.editor.getShapePageBounds(s.id)
        return b && pagePt.x >= b.minX && pagePt.x <= b.maxX && pagePt.y >= b.minY && pagePt.y <= b.maxY
      })
      if (pageShape) {
        const b = this.editor.getShapePageBounds(pageShape.id)!
        const vp = this.editor.getViewportScreenBounds()
        // Find actual text column bounds from the SVG to avoid zooming to LaTeX margins
        const contentBounds = getContentBounds(pageShape.id, b)
        const targetZoom = vp.width / contentBounds.width
        const currentZoom = this.editor.getZoomLevel()
        if (Math.abs(currentZoom - targetZoom) < 0.05) {
          // Already at fit-width — zoom out to overview
          this.editor.zoomToFit({ animation: { duration: 300, easing: EASINGS.easeOutQuint } })
        } else {
          // Zoom to fit text column width, centered on tap Y
          const camX = -contentBounds.minX
          const camY = -(pagePt.y - vp.height / targetZoom / 2)
          this.editor.setCamera(
            { x: camX, y: camY, z: targetZoom },
            { animation: { duration: 300, easing: EASINGS.easeOutQuint } }
          )
        }
      } else {
        this.editor.zoomIn(pt, { animation: { duration: 220, easing: EASINGS.easeOutQuint } })
      }
    }
  }

  override onTripleClick(info: TLClickEventInfo) {
    if (info.phase === 'settle') {
      const pt = this.editor.inputs.getCurrentScreenPoint()
      this.editor.zoomOut(pt, { animation: { duration: 320, easing: EASINGS.easeOutQuint } })
    }
  }

  override onQuadrupleClick(info: TLClickEventInfo) {
    if (info.phase === 'settle') {
      const zoom = this.editor.getZoomLevel()
      const pt = this.editor.inputs.getCurrentScreenPoint()
      if (zoom === 1) {
        this.editor.zoomToFit({ animation: { duration: 400, easing: EASINGS.easeOutQuint } })
      } else {
        this.editor.resetZoom(pt, { animation: { duration: 320, easing: EASINGS.easeOutQuint } })
      }
    }
  }
}

class PhoneIdle extends StateNode {
  static override id = 'idle'

  override onPointerDown() {
    this.parent.transition('pointing')
  }

  override onCancel() {
    // noop
  }
}

class PhonePointing extends StateNode {
  static override id = 'pointing'

  override onPointerMove() {
    if (this.editor.inputs.isDragging) {
      this.parent.transition('dragging')
    }
  }

  override onPointerUp() {
    this.parent.transition('idle')
  }

  override onCancel() {
    this.parent.transition('idle')
  }
}

class PhoneDragging extends StateNode {
  static override id = 'dragging'

  initialCamera = new Vec()
  lockedAxis: 'x' | 'y' | null = null

  override onEnter() {
    this.initialCamera = Vec.From(this.editor.getCamera())
    this.lockedAxis = null
    this.update()
  }

  override onPointerMove() {
    this.update()
  }

  override onPointerUp() {
    this.complete()
  }

  override onCancel() {
    this.parent.transition('idle')
  }

  override onComplete() {
    this.complete()
  }

  private update() {
    const { editor, initialCamera } = this
    const current = editor.inputs.getCurrentScreenPoint()
    const origin = editor.inputs.getOriginScreenPoint()
    const zoom = editor.getZoomLevel()

    let delta = Vec.Sub(current, origin).div(zoom)
    if (delta.len2() === 0) return

    // Axis lock: decide after threshold, then enforce
    if (!this.lockedAxis) {
      const screenDelta = Vec.Sub(current, origin)
      if (screenDelta.len() >= AXIS_THRESHOLD) {
        this.lockedAxis = Math.abs(screenDelta.x) > Math.abs(screenDelta.y) ? 'x' : 'y'
      }
    }

    if (this.lockedAxis === 'x') {
      delta = new Vec(delta.x, 0)
    } else if (this.lockedAxis === 'y') {
      delta = new Vec(0, delta.y)
    }

    editor.setCamera(initialCamera.clone().add(delta))
  }

  private complete() {
    const velocity = this.editor.inputs.getPointerVelocity()
    const speed = Math.min(velocity.len(), 2)

    if (speed > 0.1) {
      let direction = velocity
      // Axis-lock the momentum too
      if (this.lockedAxis === 'x') {
        direction = new Vec(velocity.x, 0).uni()
      } else if (this.lockedAxis === 'y') {
        direction = new Vec(0, velocity.y).uni()
      }
      // Lower friction for a smoother, longer glide (default is 0.09)
      this.editor.slideCamera({ speed, direction, friction: 0.04 })
    }

    this.parent.transition('idle')
  }
}
