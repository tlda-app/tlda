import { useEffect, useRef, useState } from 'react'
import type { TLViewportId } from 'tldraw'
import { getHudEditor } from '../wm/editor-host-bridge'
import { FLEET_HUD_VIEWPORT_ID } from '../wm/fleet-hud-layer'
import { pagePointToClient } from '../wm/viewport-coordinates'
import {
  clearFleetNudgeGuides,
  getFleetNudgeGuides,
  onFleetNudgeGuides,
  type FleetNudgeGuideState,
} from '../shapes/fleet-nudge-guides'
import './FleetNudgeGuides.css'

type ScreenLine = { key: string; x: number; y: number; length: number; vertical: boolean; highlighted: boolean }

/**
 * Draws the line a soft snap is pulling toward, for as long as the pull is on.
 * Without it the panel leans on its own and there is nothing on screen saying
 * what it is leaning toward.
 */
export function FleetNudgeGuides() {
  const [state, setState] = useState<FleetNudgeGuideState>(getFleetNudgeGuides)
  const [lines, setLines] = useState<ScreenLine[]>([])
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => onFleetNudgeGuides(setState), [])

  useEffect(() => {
    if (state === null) {
      setLines([])
      return
    }
    let raf = 0
    const project = () => {
      const held = stateRef.current
      // Neither handler has an end hook, so the drag ending is what clears the
      // guides — and a resize is a drag, so `select.resizing` holds them up the
      // same way `select.translating` does.
      if (held === null || !(held.isActive?.() || held.editor.isIn('select.translating') || held.editor.isIn('select.resizing'))) {
        clearFleetNudgeGuides()
        return
      }
      // A fleet panel is looked at through the HUD, which is a second viewport
      // with its own camera over the same editor. Projecting with the main
      // camera drew the hairline at coordinates for a canvas nobody is looking
      // at, which is why the guides read as missing rather than misplaced.
      // Same condition and same fallback as every other fleet-panel coordinate
      // in this codebase — see `fleetShapeAtScreenPoint` in fleet-utils.
      const viewportId = getHudEditor() ? (FLEET_HUD_VIEWPORT_ID as TLViewportId) : undefined
      const toClient = (x: number, y: number) => pagePointToClient(held.editor, { x, y }, viewportId)
      setLines(held.guides.map((guide, i) => {
        const from = guide.axis === 'x'
          ? toClient(guide.line, guide.spanFrom)
          : toClient(guide.spanFrom, guide.line)
        const to = guide.axis === 'x'
          ? toClient(guide.line, guide.spanTo)
          : toClient(guide.spanTo, guide.line)
        return {
          key: `${guide.axis}-${i}`,
          x: from.x,
          y: from.y,
          length: guide.axis === 'x' ? to.y - from.y : to.x - from.x,
          vertical: guide.axis === 'x',
          highlighted: guide.highlighted === true,
        }
      }))
      raf = requestAnimationFrame(project)
    }
    raf = requestAnimationFrame(project)
    return () => cancelAnimationFrame(raf)
  }, [state])

  if (lines.length === 0) return null

  return (
    <div className="fleet-nudge-guides">
      {lines.map(line => (
        <div
          key={line.key}
          className={`fleet-nudge-guide${line.highlighted ? ' fleet-nudge-guide--capture' : ''}`}
          data-snap-capture="true"
          style={{
            left: line.x,
            top: line.y,
            width: line.vertical ? undefined : line.length,
            height: line.vertical ? line.length : undefined,
          }}
        />
      ))}
    </div>
  )
}
