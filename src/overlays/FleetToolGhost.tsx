/**
 * FleetToolGhost — a faint, cursor-following placeholder shown while a fleet
 * panel tool is active, so you can see where the panel will land instead of
 * "placing blind." Sized to the active tool's panel footprint in screen pixels
 * (HUD camera when the HUD is open, else the main camera zoom — matching where
 * placeFleetShapeAtCursor actually drops it). Portaled to <body> so it floats
 * above the HUD too; pointer-events:none so it never intercepts the drop click.
 */
import { useEditor, useValue } from 'tldraw'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { FLEET_TOOL_DIMS } from '../shapes/fleet-utils'
import './fleet-tool-ghost.css'

export function FleetToolGhost() {
  const editor = useEditor()
  const toolId = useValue('fleetToolGhost', () => editor.getCurrentToolId(), [editor])
  const dims = FLEET_TOOL_DIMS[toolId]
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!dims) { setPos(null); return }
    const onMove = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY })
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [dims])

  if (!dims || !pos) return null
  const hud = (window as any).__tldraw_hud_editor__
  const z = hud ? hud.getCamera().z : editor.getZoomLevel()
  const w = dims.w * z
  const h = dims.h * z
  return createPortal(
    <div
      className="fleet-tool-ghost"
      style={{ left: pos.x - w / 2, top: pos.y - h / 2, width: w, height: h }}
    />,
    document.body,
  )
}
