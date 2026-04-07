/**
 * FleetHUD — toggle pill in bottom-left that expands to show fleet shapes
 * region (chat + agents) via CanvasClipPanel.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
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

/**
 * Ephemeral layout overlay — bounding-box handle around the entire fleet HUD.
 * Drag to reposition all fleet shapes as a group. Esc or click outside cancels.
 *
 * Coordinate system:
 *   - Horizontal: canvas coordinates — dragging left/right updates shape canvas X.
 *   - Vertical: screen coordinates — dragging up/down updates the panel's screen Y offset.
 */
interface FleetGroupOverlayProps {
  panelLeft: number
  panelTop: number
  panelWidth: number
  panelHeight: number
  mainEditor: Editor
  onCommit: (screenDx: number, screenDy: number) => void
  onCancel: () => void
}

function FleetGroupOverlay({
  panelLeft,
  panelTop,
  panelWidth,
  panelHeight,
  onCommit,
  onCancel,
}: FleetGroupOverlayProps) {
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const isDraggingRef = useRef(false)

  // Esc cancels
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [onCancel])

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    overlayRef.current?.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY }
    isDraggingRef.current = false
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) isDraggingRef.current = true
    setDragOffset({ x: dx, y: dy })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    const dx = e.clientX - dragRef.current.startX
    const dy = e.clientY - dragRef.current.startY
    dragRef.current = null
    setDragOffset({ x: 0, y: 0 })
    if (isDraggingRef.current) {
      onCommit(dx, dy)
    } else {
      // Tap without drag = exit layout mode
      onCancel()
    }
  }

  return (
    <>
      {/* Backdrop — clicking outside the overlay cancels layout mode */}
      <div
        className="fleet-layout-backdrop"
        onPointerDown={(e) => { e.stopPropagation(); onCancel() }}
      />
      {/* Bounding-box overlay over the HUD */}
      <div
        ref={overlayRef}
        className="fleet-layout-overlay"
        style={{
          left: panelLeft + dragOffset.x,
          top: panelTop + dragOffset.y,
          width: panelWidth,
          height: panelHeight,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div className="fleet-layout-overlay-hint">
          Drag to move · Esc to cancel
        </div>
      </div>
    </>
  )
}

export function FleetHUD({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: FleetHUDProps) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem('fleet-hud-expanded') === '1')
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => getFleetBounds(mainEditor))
  const [layoutMode, setLayoutMode] = useState(false)
  // Screen-space Y offset for the HUD panel — vertical positioning in screen coords.
  // Fleet shapes stay at fixed screen Y regardless of canvas zoom/pan.
  const [screenYOffset, setScreenYOffset] = useState(() =>
    parseFloat(localStorage.getItem('fleet-hud-y-offset') || '0') || 0
  )
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

  // Body class for layout mode — CSS disables pointer-events on shape content
  useEffect(() => {
    if (layoutMode) {
      document.body.classList.add('fleet-layout-active')
    } else {
      document.body.classList.remove('fleet-layout-active')
    }
    return () => document.body.classList.remove('fleet-layout-active')
  }, [layoutMode])

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

  // Commit layout drag — moves fleet shapes in canvas X, adjusts screen Y offset.
  const handleLayoutCommit = useCallback((screenDx: number, screenDy: number) => {
    setLayoutMode(false)
    // Horizontal: convert screen pixels → canvas units, update each shape's canvas X
    const cam = mainEditor.getCamera()
    const canvasDx = screenDx / cam.z
    const fleetShapes = mainEditor.getCurrentPageShapes()
      .filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
    if (canvasDx !== 0 && fleetShapes.length > 0) {
      mainEditor.store.put(
        fleetShapes.map(s => ({ ...s as any, x: (s as any).x + canvasDx }))
      )
    }
    // Vertical: update screen-space Y offset (clamped so HUD stays on screen)
    if (screenDy !== 0) {
      setScreenYOffset(prev => {
        const next = prev + screenDy
        localStorage.setItem('fleet-hud-y-offset', String(next))
        return next
      })
    }
  }, [mainEditor])

  const handleLayoutCancel = useCallback(() => {
    setLayoutMode(false)
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
  // Docked to right edge of viewport, vertically centered + screenYOffset
  const panelHeight = window.innerHeight * 0.8
  const zoom = panelHeight / fleetBounds.h
  const panelWidth = fleetBounds.w * zoom
  const panelLeft = hudRight - panelWidth
  const adjustedTop = (window.innerHeight - panelHeight) / 2 + screenYOffset

  return (
    <>
      {ghost}
      {layoutMode && (
        <FleetGroupOverlay
          panelLeft={panelLeft}
          panelTop={adjustedTop}
          panelWidth={panelWidth}
          panelHeight={panelHeight}
          mainEditor={mainEditor}
          onCommit={handleLayoutCommit}
          onCancel={handleLayoutCancel}
        />
      )}
      <div className="fleet-hud-wrap" ref={hudRef} style={{ left: panelLeft, top: adjustedTop }}>
        <div className="fleet-hud-controls">
          <button
            className="fleet-hud-layout"
            onClick={() => setLayoutMode(m => !m)}
            title="Move / reposition HUD"
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
