/**
 * usePanMode — toggle pan/scroll mode via auxiliary mouse buttons (3 or 4).
 *
 * When active:
 *   - Mouse movement over canvas: pans the camera in 2D without clicking
 *   - Mouse movement over chat (.fleet-chat-log): scrolls the chat container
 *   - Cursor changes to 'grab' (via body.tlda-pan-mode CSS class)
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

// Module-level so the mousemove handler always sees the current value
let panModeActive = false

function setPanMode(active: boolean) {
  panModeActive = active
  document.body.classList.toggle('tlda-pan-mode', active)
}

export function usePanMode(editorRef: RefObject<Editor | null>) {
  const lastPosRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      e.stopPropagation()
      const newActive = !panModeActive
      setPanMode(newActive)
      lastPosRef.current = newActive ? { x: e.clientX, y: e.clientY } : null
    }

    // Prevent browser back/forward navigation from aux buttons on mouseup
    const preventNav = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) e.preventDefault()
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!panModeActive) return
      const last = lastPosRef.current
      if (!last) {
        lastPosRef.current = { x: e.clientX, y: e.clientY }
        return
      }
      const dx = e.clientX - last.x
      const dy = e.clientY - last.y
      lastPosRef.current = { x: e.clientX, y: e.clientY }
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
      setPanMode(false)
      lastPosRef.current = null
    }
  }, [editorRef])
}
