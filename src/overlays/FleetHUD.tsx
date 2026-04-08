/**
 * FleetHUD — toggle pill in bottom-left that expands to show fleet shapes
 * region (chat + agents) via CanvasClipPanel.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { createShapeId } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { useFleetAgents } from '../fleet-data-adapter'
import { dropGhostState, dropGhostBus } from '../shapes/FleetPillShape'
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

/** Ghost rect shown over the empty slot when dragging a pill over bare canvas */
function FleetDropGhost({ mainEditor }: { mainEditor: Editor }) {
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  useEffect(() => {
    const handler = () => {
      const slot = dropGhostState.slot
      if (!slot) { setGhost(null); return }
      const tl = mainEditor.pageToScreen({ x: slot.x, y: slot.y })
      const br = mainEditor.pageToScreen({ x: slot.x + slot.w, y: slot.y + slot.h })
      setGhost({ x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y })
    }
    dropGhostBus.addEventListener('change', handler)
    return () => { dropGhostBus.removeEventListener('change', handler); setGhost(null) }
  }, [mainEditor])

  if (!ghost) return null
  return (
    <div
      className="fleet-drop-ghost"
      style={{ left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h }}
    />
  )
}

/** Stored HUD dimensions that override auto-calculation */
interface HudOverride {
  width: number
  height: number
  yOffset: number
}

function loadHudOverride(): HudOverride | null {
  try {
    const raw = localStorage.getItem('fleet-hud-override')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveHudOverride(o: HudOverride) {
  localStorage.setItem('fleet-hud-override', JSON.stringify(o))
}

const PROXY_SHAPE_ID = createShapeId('fleet-hud-proxy')

export function FleetHUD({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: FleetHUDProps) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem('fleet-hud-expanded') === '1')
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => getFleetBounds(mainEditor))
  const [layoutMode, setLayoutMode] = useState(false)
  const [hudOverride, setHudOverride] = useState<HudOverride | null>(loadHudOverride)
  const agents = useFleetAgents()
  const hudRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  // Track proxy shape changes during layout mode
  const layoutActiveRef = useRef(false)

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

  // Layout mode: create proxy shape on main canvas, track changes, clean up on deselect
  useEffect(() => {
    if (!layoutMode || !fleetBounds) return
    layoutActiveRef.current = true

    // Current HUD screen rect
    const autoHeight = window.innerHeight * 0.8
    const autoZoom = autoHeight / fleetBounds.h
    const autoWidth = fleetBounds.w * autoZoom
    const curWidth = hudOverride?.width ?? autoWidth
    const curHeight = hudOverride?.height ?? autoHeight
    const curLeft = hudRight - curWidth
    const defaultYOffset = hudOverride?.yOffset ?? 0
    const curTop = Math.max(0, (window.innerHeight - curHeight) / 2 + defaultYOffset)

    // Convert screen rect → page coords for the proxy shape
    const cam = mainEditor.getCamera()
    const pageX = curLeft / cam.z - cam.x
    const pageY = curTop / cam.z - cam.y
    const pageW = curWidth / cam.z
    const pageH = curHeight / cam.z

    // Create proxy geo shape on main canvas
    mainEditor.createShape({
      id: PROXY_SHAPE_ID,
      type: 'geo',
      x: pageX,
      y: pageY,
      opacity: 0.3,
      props: { w: pageW, h: pageH, geo: 'rectangle', fill: 'semi', color: 'light-blue' },
    })
    mainEditor.select(PROXY_SHAPE_ID)

    // Listen for proxy shape changes → update HUD override
    const unsub = mainEditor.store.listen(({ changes }) => {
      if (!layoutActiveRef.current) return
      for (const [, to] of Object.values(changes.updated)) {
        if ((to as any).id === PROXY_SHAPE_ID && (to as any).typeName === 'shape') {
          const shape = to as any
          const cam = mainEditor.getCamera()
          const newScreenY = (shape.y + cam.y) * cam.z
          const newScreenW = shape.props.w * cam.z
          const newScreenH = shape.props.h * cam.z
          const newYOffset = newScreenY - (window.innerHeight - newScreenH) / 2
          const override: HudOverride = { width: newScreenW, height: newScreenH, yOffset: newYOffset }
          setHudOverride(override)
          saveHudOverride(override)
        }
      }
      // Check if proxy was deselected
      for (const [, to] of Object.values(changes.updated)) {
        if ((to as any).typeName === 'instance_page_state') {
          const selectedIds = (to as any).selectedShapeIds as string[]
          if (!selectedIds.includes(PROXY_SHAPE_ID as string)) {
            // Deselected — exit layout mode
            setLayoutMode(false)
          }
        }
      }
    }, { source: 'all', scope: 'all' })

    // Esc key exits layout mode
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLayoutMode(false)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      layoutActiveRef.current = false
      unsub()
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      // Remove proxy shape
      try { mainEditor.deleteShape(PROXY_SHAPE_ID) } catch { /* already gone */ }
    }
  }, [layoutMode, mainEditor, fleetBounds, hudRight])

  const handleLayoutToggle = useCallback(() => {
    setLayoutMode(m => !m)
  }, [])

  // Don't render if no fleet shapes
  if (!fleetBounds) return null

  const ghost = <FleetDropGhost mainEditor={mainEditor} />

  // Collapsed: just the pill
  if (!expanded) {
    return (
      <>
        {ghost}
        <div className="fleet-pill-container">
          <span
            className="fleet-pill"
            onClick={() => { setExpanded(true); localStorage.setItem('fleet-hud-expanded', '1') }}
            onPointerDown={e => e.stopPropagation()}
          >
            {aliveCount > 0 ? `${aliveCount} agent${aliveCount !== 1 ? 's' : ''}` : 'Fleet'}
          </span>
        </div>
      </>
    )
  }

  // Expanded: CanvasClipPanel with fleet region
  // Auto-zoom: fit all fleet shapes within 80% screen height, width follows aspect ratio
  // If user has overridden dimensions via layout mode, use those instead.
  const autoHeight = window.innerHeight * 0.8
  const autoZoom = autoHeight / fleetBounds.h
  const autoWidth = fleetBounds.w * autoZoom

  const panelWidth = hudOverride?.width ?? autoWidth
  const panelHeight = hudOverride?.height ?? autoHeight
  const panelLeft = hudRight - panelWidth
  const yOffset = hudOverride?.yOffset ?? 0
  const rawTop = (window.innerHeight - panelHeight) / 2 + yOffset
  const adjustedTop = Math.max(0, Math.min(rawTop, window.innerHeight - 100))

  return (
    <>
      {ghost}
      <div className="fleet-hud-wrap" ref={hudRef} style={{ left: panelLeft, top: adjustedTop }}>
        <div className="fleet-hud-controls">
          <button
            className={`fleet-hud-layout${layoutMode ? ' active' : ''}`}
            onClick={handleLayoutToggle}
            title="Move / resize HUD"
          >
            ⊞
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
          panelWidth={panelWidth}
          maxHeightFraction={1}
          lockCamera={true}
          className="fleet-hud"
        />
      </div>
    </>
  )
}
