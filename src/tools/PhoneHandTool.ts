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

/**
 * True when the current pointer is over a fleet panel. The panels live in the
 * full-viewport `.fleet-hud-wrap` overlay, which is pointer-events:none EXCEPT
 * the fleet shape elements (pointer-events:auto) — so a screen-point hit-test
 * lands inside the wrap iff it's on an interactive panel. We can't use the main
 * editor's shape coords here: the panels are painted by the HUD's OVERRIDE
 * camera, so their page coords don't line up with where they actually render.
 */
function pointerOnFleetPanel(editor: Editor): boolean {
  if (typeof document === 'undefined') {
    log.debug(LOG_NS, 'phone panel gate: no document', {})
    return false
  }
  const sp = editor.inputs.getCurrentScreenPoint()
  const rect = editor.getContainer().getBoundingClientRect()
  const clientX = rect.left + sp.x
  const clientY = rect.top + sp.y
  const el = document.elementFromPoint(clientX, clientY)
  const onFleetPanel = !!el?.closest('.fleet-hud-wrap')
  log.debug(LOG_NS, 'phone panel gate', {
    onFleetPanel,
    screenPoint: { x: Math.round(sp.x), y: Math.round(sp.y) },
    clientPoint: { x: Math.round(clientX), y: Math.round(clientY) },
    target: describeElement(el),
    elementChain: log.isEnabled(LOG_NS, 'debug') ? elementChainFrom(el) : undefined,
  })
  return onFleetPanel
}

/**
 * Phone hand tool: 1-finger scroll with axis snapping.
 *
 * - Drag starts unlocked; after AXIS_THRESHOLD px, locks to dominant axis
 * - Locked axis zeroes out the other delta
 * - Momentum slide is also axis-locked
 *
 * Stands down entirely when the touch lands on a fleet panel: there a 1-finger
 * drag scrolls the panel's own content and 2-finger drives the fleet move/resize
 * gesture (useFleetGestures), so axis-locked canvas panning is irrelevant and
 * was racing the fleet gesture handler for the same fingers (the intermittent
 * "multitouch on fleet shapes only sometimes works" bug). The 3-finger
 * pass-through canvas pan keeps its own (soft) axis lock in useFleetGestures.
 *
 * Tap-to-zoom (double/triple/quad) is deliberately NOT handled here: on a phone
 * stray rapid taps were being read as multi-clicks and firing unwanted zooms.
 */
export class PhoneHandTool extends StateNode {
  static override id = 'phone-hand'
  static override initial = 'idle'
  static override isLockable = false
  static override children(): TLStateNodeConstructor[] {
    return [PhoneIdle, PhonePointing, PhoneDragging]
  }
}

class PhoneIdle extends StateNode {
  static override id = 'idle'

  override onPointerDown() {
    // Touch on a fleet panel → stand down so the panel's own scroll + the
    // 2-finger move/resize gesture run without this axis-locked pan racing them.
    if (pointerOnFleetPanel(this.editor)) {
      log.debug(LOG_NS, 'phone hand tool stand down', {})
      return
    }
    log.debug(LOG_NS, 'phone hand tool enter pointing', {})
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
