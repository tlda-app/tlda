/**
 * Shared drag coordinator for fleet shapes.
 *
 * Eliminates the capture-phase listener registration race between
 * FleetAgentsShape, FleetChatShape, and FleetPillShape. One global
 * capture-phase listener pair (pointermove + pointerup) dispatches
 * to whichever drag handler is currently active.
 *
 * Usage:
 *   // In component:
 *   dragCoordinator.claim(onMove, onUp)   // start of drag
 *   dragCoordinator.release()             // end of drag (also called by coordinator on pointerup)
 */

interface DragHandlers {
  onMove: (e: PointerEvent) => void
  onUp: (e: PointerEvent) => void
  onCancel?: () => void
}

let active: DragHandlers | null = null
let installed = false

function installListeners() {
  if (installed) return
  installed = true

  document.addEventListener('pointermove', (e: PointerEvent) => {
    if (!active) return
    e.stopImmediatePropagation()
    e.preventDefault()
    active.onMove(e)
  }, { capture: true })

  document.addEventListener('pointerup', (e: PointerEvent) => {
    if (!active) return
    e.stopImmediatePropagation()
    const handlers = active
    active = null
    handlers.onUp(e)
  }, { capture: true })

  const cancelActive = () => {
    if (!active) return
    const handlers = active
    active = null
    handlers.onCancel?.()
  }
  document.addEventListener('pointercancel', cancelActive, { capture: true })
  // NOT lostpointercapture. Touch pointers are *implicitly* captured by the
  // browser to the element that received pointerdown; that capture is released
  // — firing lostpointercapture — as a normal part of a touch drag, e.g. when
  // the origin element re-renders or the finger leaves it. Cancelling on it
  // deleted the drag pill the instant a finger started moving, so a touch drag
  // produced a pill that immediately vanished and the filter overlay (which is
  // gated on the pill's bounds reaching the chat shape) never opened. Mouse was
  // unaffected because mouse pointers are not implicitly captured.
  // pointercancel already covers genuine interruption.
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') cancelActive()
  }, { capture: true })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelActive()
  })
  window.addEventListener('blur', cancelActive, true)
  window.addEventListener('pagehide', cancelActive, true)
}

export const dragCoordinator = {
  /** Claim the drag — only one drag can be active at a time. */
  claim(onMove: (e: PointerEvent) => void, onUp: (e: PointerEvent) => void, onCancel?: () => void) {
    installListeners()
    active?.onCancel?.()
    const handlers = { onMove, onUp, onCancel }
    active = handlers
    return () => {
      if (active !== handlers) return
      active = null
      handlers.onCancel?.()
    }
  },

  /** Release the active drag (idempotent). */
  release() {
    active = null
  },

  /** Check if a drag is currently active. */
  get isActive() {
    return active !== null
  },
}
