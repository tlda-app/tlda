/**
 * FleetHUD — toggle pill in bottom-left that expands to show fleet shapes
 * region (chat + agents) via CanvasClipPanel.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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
  const hudRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // Reactively update fleet bounds when shapes change.
  // Position updates: freeze during drag, recalculate on pointerup only.
  // This prevents the auto-zoom panel from resizing mid-drag.
  useEffect(() => {
    setFleetBounds(getFleetBounds(mainEditor))

    const unsub = mainEditor.store.listen(({ changes }) => {
      const isFleetChange = (record: any) =>
        record.typeName === 'shape' && FLEET_SHAPE_TYPES.includes(record.type)

      // Immediate: add/remove always recalculates
      const hasAddOrRemove =
        Object.values(changes.added).some(isFleetChange) ||
        Object.values(changes.removed).some(isFleetChange)

      if (hasAddOrRemove) {
        draggingRef.current = false
        setFleetBounds(getFleetBounds(mainEditor))
        return
      }

      // Position/size updates: mark as dragging, recalc on pointerup
      const hasUpdate = Object.values(changes.updated)
        .some(([from, to]) => isFleetChange(from) || isFleetChange(to))

      if (hasUpdate) {
        draggingRef.current = true
      }
    }, { source: 'all', scope: 'document' })

    const handlePointerUp = () => {
      if (draggingRef.current) {
        draggingRef.current = false
        setFleetBounds(getFleetBounds(mainEditor))
      }
    }
    window.addEventListener('pointerup', handlePointerUp, true)

    return () => {
      unsub()
      window.removeEventListener('pointerup', handlePointerUp, true)
    }
  }, [mainEditor])

  // When HUD is expanded, add a body class so CSS can hide fleet shapes in the
  // main canvas — avoids the "two copies" issue where both the HUD and main
  // canvas show the same shapes simultaneously.
  useEffect(() => {
    if (expanded && fleetBounds) {
      document.body.classList.add('fleet-hud-open')
    } else {
      document.body.classList.remove('fleet-hud-open')
    }
    return () => document.body.classList.remove('fleet-hud-open')
  }, [expanded, fleetBounds])

  const aliveCount = useMemo(() => {
    return agents.filter((a: any) => !a.dead && !a.human).length
  }, [agents])

  // Track fleet shapes' screen-space right edge — anchored to canvas position
  const [hudRight, setHudRight] = useState(0)
  useEffect(() => {
    if (!expanded || !fleetBounds) return
    let rafId: number
    let lastCamX = mainEditor.getCamera().x
    let lastCamZ = mainEditor.getCamera().z
    const update = () => {
      const cam = mainEditor.getCamera()
      lastCamX = cam.x
      lastCamZ = cam.z
      setHudRight((fleetBounds.x + fleetBounds.w + cam.x) * cam.z)
    }
    const poll = () => {
      const cam = mainEditor.getCamera()
      if (cam.x !== lastCamX || cam.z !== lastCamZ || hudRight === 0) {
        update()
      }
      rafId = requestAnimationFrame(poll)
    }
    update()
    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [mainEditor, expanded, fleetBounds])

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
  // Auto-zoom: fit all fleet shapes within 80% screen height, width follows aspect ratio
  // Docked to right edge of viewport, vertically centered
  const panelHeight = window.innerHeight * 0.8
  const zoom = panelHeight / fleetBounds.h
  const panelWidth = fleetBounds.w * zoom
  const adjustedTop = (window.innerHeight - panelHeight) / 2
  return (
    <div className="fleet-hud-wrap" ref={hudRef} style={{ left: hudRight - panelWidth, top: adjustedTop }}>
      <div className="fleet-hud-controls">
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
        panelWidth={panelWidth}
        maxHeightFraction={1}
        lockCamera={true}
        className="fleet-hud"
      />
    </div>
  )
}
