/**
 * FleetHUD — toggle pill in bottom-left that expands to show fleet shapes
 * region (chat + agents) via CanvasClipPanel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const [expanded, setExpanded] = useState(() => localStorage.getItem('fleet-hud-expanded') === '1')
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => getFleetBounds(mainEditor))
  const agents = useFleetAgents()
  const [hudScale, setHudScale] = useState(1)
  const hudRef = useRef<HTMLDivElement>(null)

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

  // Cmd+scroll on the HUD grows/shrinks the panel
  useEffect(() => {
    const el = hudRef.current
    if (!el || !expanded) return
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      const delta = e.deltaY > 0 ? -0.03 : 0.03
      setHudScale(s => Math.min(2, Math.max(0.5, s + delta)))
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [expanded])

  // Don't render if no fleet shapes
  if (!fleetBounds) return null

  // Collapsed: just the pill
  if (!expanded) {
    return (
      <div className="fleet-pill-container">
        <span
          className="fleet-pill"
          onClick={() => { setExpanded(true); localStorage.setItem('fleet-hud-expanded', '1') }}
          onPointerDown={e => e.stopPropagation()}
        >
          {aliveCount > 0 ? `${aliveCount} agent${aliveCount !== 1 ? 's' : ''}` : 'Fleet'}
        </span>
      </div>
    )
  }

  // Expanded: CanvasClipPanel with fleet region
  // Right edge stays fixed — scaling expands leftward to reveal more fleet shapes
  const scaledWidth = fleetBounds.w * hudScale
  const adjustedLeft = hudLeft + fleetBounds.w - scaledWidth
  return (
    <div className="fleet-hud-wrap" ref={hudRef} style={{ left: adjustedLeft }}>
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
          onClick={() => { setExpanded(false); localStorage.setItem('fleet-hud-expanded', '0') }}
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
        panelWidth={scaledWidth}
        maxHeightFraction={0.95}
        lockCamera={true}
        className="fleet-hud"
      />
    </div>
  )
}
