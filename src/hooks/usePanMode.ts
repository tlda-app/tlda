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
 *   - Speed: linear ramp — 0 at zone boundary, max at the very edge
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

const CHAT_SCROLL_SENSITIVITY = 1.0

// Edge-zone constants — tunable
const EDGE_ZONE_PX = 40       // depth of top/bottom edge zone (chat and viewport)
const CHAT_MAX_SPEED = 300    // chat scroll px/s at the very edge
const CANVAS_MAX_SPEED = 400  // canvas pan screen-px/s at the very edge

// Module-level so event handlers always see current value without closure staleness
let panModeActive = false

function setPanMode(active: boolean) {
  panModeActive = active
  document.body.classList.toggle('tlda-pan-mode', active)
}

export function usePanMode(editorRef: RefObject<Editor | null>) {
  const lastPosRef = useRef<{ x: number; y: number } | null>(null)

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
            velocity = -CHAT_MAX_SPEED * (1 - relY / EDGE_ZONE_PX)
          } else if (relY > h - EDGE_ZONE_PX) {
            // Bottom zone: scroll down (see newer messages, scrollTop increases)
            velocity = CHAT_MAX_SPEED * (1 - (h - relY) / EDGE_ZONE_PX)
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
              vx = -CANVAS_MAX_SPEED * (1 - pos.x / EDGE_ZONE_PX)
            } else if (pos.x > W - EDGE_ZONE_PX) {
              vx = CANVAS_MAX_SPEED * (1 - (W - pos.x) / EDGE_ZONE_PX)
            }
            // Top/bottom viewport edges → pan canvas up/down
            if (pos.y < EDGE_ZONE_PX) {
              vy = -CANVAS_MAX_SPEED * (1 - pos.y / EDGE_ZONE_PX)
            } else if (pos.y > H - EDGE_ZONE_PX) {
              vy = CANVAS_MAX_SPEED * (1 - (H - pos.y) / EDGE_ZONE_PX)
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

    // Prevent browser back/forward navigation from aux buttons on mouseup
    const preventNav = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault()
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
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const chatLog = el?.closest('.fleet-chat-log') as HTMLElement | null
      if (chatLog) {
        // Mouse down (dy > 0) = scroll down (see newer), mouse up = scroll up (see older)
        chatLog.scrollTop += dy * CHAT_SCROLL_SENSITIVITY
        return
      }

      // Pan the canvas: moving mouse right/down pans the canvas in that direction
      const editor = editorRef.current
      if (!editor) return
      const cam = editor.getCamera()
      editor.setCamera({
        x: cam.x + dx / cam.z,
        y: cam.y + dy / cam.z,
        z: cam.z,
      })
    }

    window.addEventListener('mousedown', handleMouseDown, { capture: true })
    window.addEventListener('mouseup', preventNav, { capture: true })
    window.addEventListener('mousemove', handleMouseMove, { passive: true })

    return () => {
      window.removeEventListener('mousedown', handleMouseDown, { capture: true })
      window.removeEventListener('mouseup', preventNav, { capture: true })
      window.removeEventListener('mousemove', handleMouseMove)
      stopEdgeRaf()
      setPanMode(false)
      lastPosRef.current = null
    }
  }, [editorRef])
}
