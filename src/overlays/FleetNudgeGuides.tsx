import { useEffect, useRef, useState } from 'react'
import {
  clearFleetNudgeGuides,
  getFleetNudgeGuides,
  onFleetNudgeGuides,
  type FleetNudgeGuideState,
} from '../shapes/fleet-nudge-guides'
import './FleetNudgeGuides.css'

type ScreenLine = { key: string; x: number; y: number; length: number; vertical: boolean }

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
      // The translate handler has no end hook, so the drag ending is what
      // clears the guides.
      if (held === null || !held.editor.isIn('select.translating')) {
        clearFleetNudgeGuides()
        return
      }
      setLines(held.guides.map((guide, i) => {
        const from = guide.axis === 'x'
          ? held.editor.pageToScreen({ x: guide.line, y: guide.spanFrom })
          : held.editor.pageToScreen({ x: guide.spanFrom, y: guide.line })
        const to = guide.axis === 'x'
          ? held.editor.pageToScreen({ x: guide.line, y: guide.spanTo })
          : held.editor.pageToScreen({ x: guide.spanTo, y: guide.line })
        return {
          key: `${guide.axis}-${i}`,
          x: from.x,
          y: from.y,
          length: guide.axis === 'x' ? to.y - from.y : to.x - from.x,
          vertical: guide.axis === 'x',
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
          className="fleet-nudge-guide"
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
