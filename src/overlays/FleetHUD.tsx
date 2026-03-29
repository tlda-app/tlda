/**
 * FleetHUD — toggle pill in bottom-left that expands to show fleet shapes
 * region (chat + agents) via CanvasClipPanel.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { useFleetAgents } from '../fleet-data-adapter'
import './FleetHUD.css'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search']

interface FleetHUDProps {
  mainEditor: Editor
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

function getFleetBounds(editor: Editor): ClipBounds | null {
  const shapes = editor.getCurrentPageShapes()
    .filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
  if (shapes.length === 0) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of shapes) {
    const bounds = editor.getShapePageBounds(s.id)
    if (!bounds) continue
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.w)
    maxY = Math.max(maxY, bounds.y + bounds.h)
  }
  if (!isFinite(minX)) return null

  const PAD = 20
  return {
    x: minX - PAD,
    y: minY - PAD,
    w: maxX - minX + PAD * 2,
    h: maxY - minY + PAD * 2,
  }
}

export function FleetHUD({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: FleetHUDProps) {
  const [expanded, setExpanded] = useState(false)
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => getFleetBounds(mainEditor))
  const agents = useFleetAgents()

  // Reactively update fleet bounds when shapes change
  useEffect(() => {
    setFleetBounds(getFleetBounds(mainEditor))

    const unsub = mainEditor.store.listen(({ changes }) => {
      const isFleetChange = (record: any) =>
        record.typeName === 'shape' && FLEET_SHAPE_TYPES.includes(record.type)

      const hasFleetChange =
        Object.values(changes.added).some(isFleetChange) ||
        Object.values(changes.removed).some(isFleetChange) ||
        Object.values(changes.updated).some(([from, to]) => isFleetChange(from) || isFleetChange(to))

      if (hasFleetChange) {
        setFleetBounds(getFleetBounds(mainEditor))
      }
    }, { source: 'all', scope: 'document' })

    return unsub
  }, [mainEditor])

  const aliveCount = useMemo(() => {
    return agents.filter((a: any) => !a.dead && !a.human).length
  }, [agents])

  // Track fleet shapes' screen-space horizontal position when expanded
  // When the user pans the main editor, the HUD shifts to stay aligned with the document margin
  const [hudLeft, setHudLeft] = useState(0)
  useEffect(() => {
    if (!expanded || !fleetBounds) return
    let rafId: number
    let lastCamX = mainEditor.getCamera().x
    const poll = () => {
      const cam = mainEditor.getCamera()
      if (cam.x !== lastCamX || hudLeft === 0) {
        lastCamX = cam.x
        const screenX = (fleetBounds.x + cam.x) * cam.z
        setHudLeft(screenX)
      }
      rafId = requestAnimationFrame(poll)
    }
    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [mainEditor, expanded, fleetBounds])

  // Lock state — check if fleet shapes are locked
  const [isLocked, setIsLocked] = useState(true)
  useEffect(() => {
    const check = () => {
      const shapes = mainEditor.getCurrentPageShapes().filter(s => FLEET_SHAPE_TYPES.includes(s.type))
      setIsLocked(shapes.length === 0 || (shapes[0].isLocked ?? true))
    }
    check()
    const unsub = mainEditor.store.listen(() => check(), { source: 'all', scope: 'document' })
    return unsub
  }, [mainEditor])

  const toggleLock = useCallback(() => {
    const shapes = mainEditor.getCurrentPageShapes().filter(s => FLEET_SHAPE_TYPES.includes(s.type))
    if (shapes.length === 0) return
    const newLocked = !(shapes[0].isLocked ?? true)
    for (const s of shapes) {
      mainEditor.updateShape({ id: s.id, type: s.type, isLocked: newLocked })
    }
    mainEditor.user.updateUserPreferences({ isSnapMode: !newLocked })
  }, [mainEditor])

  // Don't render if no fleet shapes
  if (!fleetBounds) return null

  // Collapsed: just the pill
  if (!expanded) {
    return (
      <div className="fleet-pill-container">
        <span
          className="fleet-pill"
          onClick={() => setExpanded(true)}
          onPointerDown={e => e.stopPropagation()}
        >
          {aliveCount > 0 ? `${aliveCount} agent${aliveCount !== 1 ? 's' : ''}` : 'Fleet'}
        </span>
      </div>
    )
  }

  // Expanded: CanvasClipPanel with fleet region
  return (
    <div className="fleet-hud-wrap" style={{ left: hudLeft }}>
      <div className="fleet-hud-controls">
        <button
          className="fleet-hud-lock"
          onClick={toggleLock}
          title={isLocked ? 'Unlock fleet layout' : 'Lock fleet layout'}
        >
          {isLocked ? '🔒' : '🔓'}
        </button>
        <button
          className="fleet-hud-close"
          onClick={() => setExpanded(false)}
          title="Collapse"
        >
          ×
        </button>
      </div>
      <CanvasClipPanel
        mainEditor={mainEditor}
        bounds={fleetBounds}
        shapeUtils={shapeUtils}
        tools={tools}
        licenseKey={licenseKey}
        panelWidth={fleetBounds.w}
        maxHeightFraction={1.0}
        lockCamera={true}
        className="fleet-hud"
      />
    </div>
  )
}
