/**
 * usePanMode — toggle pan/scroll mode via auxiliary mouse buttons (3 or 4).
 *
 * When active:
 *   - Mouse movement over canvas: pans the camera in 2D without clicking
 *   - Mouse movement over chat (.fleet-chat-log): scrolls the chat container
 *   - Cursor changes to 'grab' (via body.tlda-pan-mode CSS class)
 *
 * Edge-zone continuous scroll/pan (RTS-style):
 *   - Chat top/bottom edge (EDGE_ZONE_PX): continuous chat scroll while cursor stays
 *   - Viewport edges (EDGE_ZONE_PX): continuous canvas pan while cursor stays
 *   - Hit-test priority: chat zone wins over canvas zone
 *   - Speed: shaped by the shared response-curve pref (same curve as foot cursor)
 *   - No visual affordance (invisible by design; Skip's preference)
 *
 * The Logitech Lift side button can send either button 3 or 4 depending on
 * OS configuration, so both are handled.
 *
 * Pan mode is an overlay on the current tool — it intercepts mousemove but
 * doesn't switch tools. When inactive, zero impact on existing behavior.
 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { Editor } from 'tldraw'
import { buildLookup } from '../curveEditor'
import { getPref, subscribePref } from '../preferences'

const CHAT_SCROLL_SENSITIVITY = 1.0

const EDGE_ZONE_PX = 40
const CHAT_MAX_SPEED = 2000    // chat scroll px/s at the very edge
const CANVAS_MAX_SPEED = 2500  // canvas pan screen-px/s at the very edge

const AXIS_EMA_ALPHA = 0.25
const AXIS_FREE_BAND = 0.15
const AXIS_LOCK_SHARPNESS = 1.4

const AXIS_EMA_EPSILON = 0.001

// Module-level so event handlers always see current value without closure staleness
let panModeActive = false
let axisEmaX = 0
let axisEmaY = 0

function resetAxisEstimate() {
  axisEmaX = 0
  axisEmaY = 0
}

function smoothstep(t: number) {
  const x = Math.max(0, Math.min(1, t))
  return x * x * (3 - 2 * x)
}

function getAxisGains(dx: number, dy: number) {
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)

  axisEmaX = axisEmaX * (1 - AXIS_EMA_ALPHA) + adx * AXIS_EMA_ALPHA
  axisEmaY = axisEmaY * (1 - AXIS_EMA_ALPHA) + ady * AXIS_EMA_ALPHA

  const total = axisEmaX + axisEmaY
  if (total <= AXIS_EMA_EPSILON) return { gx: 1, gy: 1 }

  const r = axisEmaX / total
  const low = 0.5 - AXIS_FREE_BAND
  const high = 0.5 + AXIS_FREE_BAND

  if (r >= low && r <= high) return { gx: 1, gy: 1 }

  if (r > high) {
    const t = ((r - high) / (1 - high)) * AXIS_LOCK_SHARPNESS
    return { gx: 1, gy: 1 - smoothstep(t) }
  }

  const t = ((low - r) / low) * AXIS_LOCK_SHARPNESS
  return { gx: 1 - smoothstep(t), gy: 1 }
}

function setPanMode(active: boolean) {
  panModeActive = active
  resetAxisEstimate()
  document.body.classList.toggle('tlda-pan-mode', active)
}

export function usePanMode(editorRef: RefObject<Editor | null>) {
  const lastPosRef = useRef<{ x: number; y: number } | null>(null)
  const curveRef = useRef<(x: number) => number>(buildLookup(getPref('response-curve').h1, getPref('response-curve').h2))

  useEffect(() => {
    const updateCurve = () => {
      const c = getPref('response-curve')
      curveRef.current = buildLookup(c.h1, c.h2)
    }
    updateCurve()
    return subscribePref(updateCurve)
  }, [])

  useEffect(() => {
    // RAF loop state (closure-scoped so cleanup can cancel it)
    let edgeRafId: number | null = null
    let edgePrevTs: number | null = null

    const edgeTick = (ts: number) => {
      if (!panModeActive) { edgeRafId = null; return }

      const dt = edgePrevTs != null ? Math.min((ts - edgePrevTs) / 1000, 0.1) : 0
      edgePrevTs = ts

      const pos = lastPosRef.current
      if (pos && dt > 0) {
        const curveFn = curveRef.current

        // --- 1. Chat edge zones (innermost wins) ---
        let handledByChat = false
        const chatLogs = document.querySelectorAll('.fleet-chat-log')
        for (const el of chatLogs) {
          const rect = el.getBoundingClientRect()
          // Must be horizontally within the chat container
          if (pos.x < rect.left || pos.x > rect.right) continue
          // Must be vertically within the chat container
          if (pos.y < rect.top || pos.y > rect.bottom) continue

          const relY = pos.y - rect.top
          const h = rect.height
          let velocity = 0
          if (relY < EDGE_ZONE_PX) {
            // Top zone: scroll up (see older messages, scrollTop decreases)
            velocity = -curveFn(1 - relY / EDGE_ZONE_PX) * CHAT_MAX_SPEED
          } else if (relY > h - EDGE_ZONE_PX) {
            // Bottom zone: scroll down (see newer messages, scrollTop increases)
            velocity = curveFn(1 - (h - relY) / EDGE_ZONE_PX) * CHAT_MAX_SPEED
          }
          if (velocity !== 0) {
            (el as HTMLElement).scrollTop += velocity * dt
            handledByChat = true
          }
        }

        // --- 2. Canvas viewport edges (if not handled by a chat zone) ---
        if (!handledByChat) {
          const editor = editorRef.current
          if (editor) {
            const W = window.innerWidth
            const H = window.innerHeight
            let vx = 0, vy = 0

            // Left/right viewport edges → pan canvas left/right
            if (pos.x < EDGE_ZONE_PX) {
              vx = -curveFn(1 - pos.x / EDGE_ZONE_PX) * CANVAS_MAX_SPEED
            } else if (pos.x > W - EDGE_ZONE_PX) {
              vx = curveFn(1 - (W - pos.x) / EDGE_ZONE_PX) * CANVAS_MAX_SPEED
            }
            // Top/bottom viewport edges → pan canvas up/down
            if (pos.y < EDGE_ZONE_PX) {
              vy = -curveFn(1 - pos.y / EDGE_ZONE_PX) * CANVAS_MAX_SPEED
            } else if (pos.y > H - EDGE_ZONE_PX) {
              vy = curveFn(1 - (H - pos.y) / EDGE_ZONE_PX) * CANVAS_MAX_SPEED
            }

            if (vx !== 0 || vy !== 0) {
              const cam = editor.getCamera()
              editor.setCamera({
                x: cam.x + vx * dt / cam.z,
                y: cam.y + vy * dt / cam.z,
                z: cam.z,
              })
            }
          }
        }
      }

      edgeRafId = requestAnimationFrame(edgeTick)
    }

    const startEdgeRaf = () => {
      if (edgeRafId == null) { edgePrevTs = null; edgeRafId = requestAnimationFrame(edgeTick) }
    }
    const stopEdgeRaf = () => {
      if (edgeRafId != null) { cancelAnimationFrame(edgeRafId); edgeRafId = null }
    }

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      e.stopPropagation()
      const newActive = !panModeActive
      setPanMode(newActive)
      if (newActive) {
        lastPosRef.current = { x: e.clientX, y: e.clientY }
        startEdgeRaf()
      } else {
        lastPosRef.current = null
        stopEdgeRaf()
      }
    }

    // Prevent browser back/forward navigation from aux buttons. Browsers perform
    // that navigation on auxclick, not mouseup, so both events must be claimed.
    const preventNav = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      e.stopPropagation()
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!panModeActive) return
      // Capture old position for delta, then update to current
      const last = lastPosRef.current
      lastPosRef.current = { x: e.clientX, y: e.clientY }
      if (!last) return
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      if (dx === 0 && dy === 0) return

      // Check if cursor is over a chat scroll container
      const target = e.target instanceof Element ? e.target : null
      const chatLog = target?.closest('.fleet-chat-log') as HTMLElement | null
      if (chatLog) {
        chatLog.scrollTop += dy * CHAT_SCROLL_SENSITIVITY
        return
      }

      const { gx, gy } = getAxisGains(dx, dy)
      const panDx = dx * gx
      const panDy = dy * gy

      const editor = editorRef.current
      if (!editor) return
      const cam = editor.getCamera()
      editor.setCamera({
        x: cam.x + panDx / cam.z,
        y: cam.y + panDy / cam.z,
        z: cam.z,
      })
    }

    window.addEventListener('mousedown', handleMouseDown, { capture: true })
    window.addEventListener('mouseup', preventNav, { capture: true })
    window.addEventListener('auxclick', preventNav, { capture: true })
    window.addEventListener('mousemove', handleMouseMove, { passive: true })

    return () => {
      window.removeEventListener('mousedown', handleMouseDown, { capture: true })
      window.removeEventListener('mouseup', preventNav, { capture: true })
      window.removeEventListener('auxclick', preventNav, { capture: true })
      window.removeEventListener('mousemove', handleMouseMove)
      stopEdgeRaf()
      setPanMode(false)
      lastPosRef.current = null
    }
  }, [editorRef])
}
