import { StateNode, Vec, type Editor, type TLStateNodeConstructor } from 'tldraw'
import { log } from '../logger'

const AXIS_THRESHOLD = 5 // px before locking axis
const LOG_NS = 'fleet-gesture'

function describeElement(el: Element | null) {
  if (!el) return null
  let pointerEvents: string | null = null
  try {
    pointerEvents = window.getComputedStyle(el).pointerEvents
  } catch {
    pointerEvents = null
  }
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el instanceof HTMLElement || el instanceof SVGElement ? Array.from(el.classList).slice(0, 8) : [],
    shapeId: el.getAttribute('data-shape-id') || undefined,
    shapeType: el.getAttribute('data-shape-type') || undefined,
    role: el.getAttribute('role') || undefined,
    pointerEvents,
  }
}

function elementChainFrom(el: Element | null) {
  const chain: ReturnType<typeof describeElement>[] = []
  let cur = el
  for (let i = 0; cur && i < 10; i++) {
    chain.push(describeElement(cur))
    if (cur.classList.contains('fleet-hud-wrap')) break
    cur = cur.parentElement
  }
  return chain
}

function pointerOnFleetPanel(editor: Editor): boolean {
  if (typeof document === 'undefined') {
    log.debug(LOG_NS, 'hand panel gate: no document', {})
    return false
  }
  const sp = editor.inputs.getCurrentScreenPoint()
  const rect = editor.getContainer().getBoundingClientRect()
  const clientX = rect.left + sp.x
  const clientY = rect.top + sp.y
  const el = document.elementFromPoint(clientX, clientY)
  const onFleetPanel = !!el?.closest('.fleet-hud-wrap')
  log.debug(LOG_NS, 'hand panel gate', {
    onFleetPanel,
    screenPoint: { x: Math.round(sp.x), y: Math.round(sp.y) },
    clientPoint: { x: Math.round(clientX), y: Math.round(clientY) },
    target: describeElement(el),
    elementChain: log.isEnabled(LOG_NS, 'debug') ? elementChainFrom(el) : undefined,
  })
  return onFleetPanel
}

export class SoftAxisHandTool extends StateNode {
  static override id = 'hand'
  static override initial = 'idle'
  static override isLockable = false
  static override children(): TLStateNodeConstructor[] {
    return [HandIdle, HandPointing, HandDragging]
  }
}

class HandIdle extends StateNode {
  static override id = 'idle'

  override onPointerDown() {
    if (pointerOnFleetPanel(this.editor)) {
      log.debug(LOG_NS, 'soft-axis hand stand down', {})
      return
    }
    log.debug(LOG_NS, 'soft-axis hand enter pointing', {})
    this.parent.transition('pointing')
  }

  override onCancel() {
    // noop
  }
}

class HandPointing extends StateNode {
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

class HandDragging extends StateNode {
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
    const editor = this.editor

    if (this.lockedAxis === 'y') {
      // slideCamera moves speed * direction per ms and clamps speed to 1 px/ms,
      // so any flick faster than that has to carry the excess in the direction
      // vector's length. A unit direction capped every release at 1 px/ms —
      // well under the 3-6 px/ms of a thumb flick — so the glide started
      // slower than the finger and read as the scroll stopping dead.
      const vy = editor.inputs.getPointerVelocity().y
      const pointerSpeed = Math.abs(vy)
      if (pointerSpeed > 0.1) {
        const speed = Math.min(pointerSpeed, 1)
        const direction = new Vec(0, Math.sign(vy) * (pointerSpeed / speed))
        editor.slideCamera({ speed, direction, friction: 0.04 })
      }
    }
    this.parent.transition('idle')
  }
}
