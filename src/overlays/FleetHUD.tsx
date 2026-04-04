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

// Resize handle definitions: id, cursor, CSS position, dy direction
// dy: +1 = dragging south (positive clientY) increases height
//     -1 = dragging north (negative clientY) increases height
//      0 = east/west only (no height change in height-only resize model)
type ResizeHandle = {
  id: string
  cursor: string
  style: React.CSSProperties
  dy: number
}
const RESIZE_HANDLES: ResizeHandle[] = [
  { id: 'nw', cursor: 'nw-resize', style: { top: 0, left: 0 }, dy: -1 },
  { id: 'n',  cursor: 'n-resize',  style: { top: 0, left: '50%', transform: 'translateX(-50%)' }, dy: -1 },
  { id: 'ne', cursor: 'ne-resize', style: { top: 0, right: 0 }, dy: -1 },
  { id: 'e',  cursor: 'e-resize',  style: { top: '50%', right: 0, transform: 'translateY(-50%)' }, dy: 0 },
  { id: 'se', cursor: 'se-resize', style: { bottom: 0, right: 0 }, dy: 1 },
  { id: 's',  cursor: 's-resize',  style: { bottom: 0, left: '50%', transform: 'translateX(-50%)' }, dy: 1 },
  { id: 'sw', cursor: 'sw-resize', style: { bottom: 0, left: 0 }, dy: 1 },
  { id: 'w',  cursor: 'w-resize',  style: { top: '50%', left: 0, transform: 'translateY(-50%)' }, dy: 0 },
]

export function FleetHUD({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: FleetHUDProps) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem('fleet-hud-expanded') === '1')
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => getFleetBounds(mainEditor))

  // Screen-space Y offset for the HUD panel — vertical positioning in screen coords.
  // Fleet shapes stay at fixed screen Y regardless of canvas zoom/pan.
  const [screenYOffset, setScreenYOffset] = useState(() =>
    parseFloat(localStorage.getItem('fleet-hud-y-offset') || '0') || 0
  )

  // User-set panel height (null = auto 80vh). Persisted in localStorage.
  const [userPanelH, setUserPanelH] = useState<number | null>(() => {
    const v = localStorage.getItem('fleet-hud-panel-h')
    return v ? parseFloat(v) : null
  })

  // Live drag offset for the controls bar drag — applied as CSS offset during drag,
  // then committed to screenYOffset + shape canvas X on pointerup.
  const [panelDragOffset, setPanelDragOffset] = useState({ x: 0, y: 0 })

  const agents = useFleetAgents()
  const hudRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
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

  // ── Controls bar drag (move whole panel) ──────────────────────────────────

  const barDragRef = useRef<{ startX: number; startY: number } | null>(null)

  const onBarPointerDown = useCallback((e: React.PointerEvent) => {
    // Only trigger on the bar itself, not buttons
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    e.stopPropagation()
    barRef.current?.setPointerCapture(e.pointerId)
    barDragRef.current = { startX: e.clientX, startY: e.clientY }
  }, [])

  const onBarPointerMove = useCallback((e: React.PointerEvent) => {
    if (!barDragRef.current) return
    const dx = e.clientX - barDragRef.current.startX
    const dy = e.clientY - barDragRef.current.startY
    setPanelDragOffset({ x: dx, y: dy })
  }, [])

  const onBarPointerUp = useCallback((e: React.PointerEvent) => {
    if (!barDragRef.current) return
    const dx = e.clientX - barDragRef.current.startX
    const dy = e.clientY - barDragRef.current.startY
    barDragRef.current = null
    setPanelDragOffset({ x: 0, y: 0 })

    // Commit horizontal: move fleet shapes in canvas coords
    if (Math.abs(dx) > 1) {
      const cam = mainEditor.getCamera()
      const canvasDx = dx / cam.z
      const fleetShapes = mainEditor.getCurrentPageShapes()
        .filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
      if (fleetShapes.length > 0) {
        mainEditor.store.put(
          fleetShapes.map(s => ({ ...s as any, x: (s as any).x + canvasDx }))
        )
      }
    }

    // Commit vertical: update screen-space Y offset
    if (Math.abs(dy) > 1) {
      setScreenYOffset(prev => {
        const next = prev + dy
        localStorage.setItem('fleet-hud-y-offset', String(next))
        return next
      })
    }
  }, [mainEditor])

  // ── Resize handles ────────────────────────────────────────────────────────

  const resizeDragRef = useRef<{
    startY: number
    startH: number
    dy: number
  } | null>(null)

  const onResizePointerDown = useCallback((e: React.PointerEvent, handleDy: number, currentH: number) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resizeDragRef.current = { startY: e.clientY, startH: currentH, dy: handleDy }
  }, [])

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeDragRef.current) return
    const { startY, startH, dy } = resizeDragRef.current
    if (dy === 0) return
    const delta = (e.clientY - startY) * dy
    const newH = Math.max(200, Math.min(window.innerHeight * 0.95, startH + delta))
    setUserPanelH(newH)
  }, [])

  const onResizePointerUp = useCallback((e: React.PointerEvent) => {
    if (!resizeDragRef.current) return
    const { startY, startH, dy } = resizeDragRef.current
    resizeDragRef.current = null
    if (dy === 0) return
    const delta = (e.clientY - startY) * dy
    const newH = Math.max(200, Math.min(window.innerHeight * 0.95, startH + delta))
    setUserPanelH(newH)
    localStorage.setItem('fleet-hud-panel-h', String(newH))
  }, [])

  // ─────────────────────────────────────────────────────────────────────────

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
  // effectivePanelH: user-set height, or auto 80vh
  // Width follows aspect ratio: panelWidth = fleetBounds.w * zoom
  const effectivePanelH = userPanelH ?? (window.innerHeight * 0.8)
  const zoom = effectivePanelH / fleetBounds.h
  const panelWidth = fleetBounds.w * zoom
  const panelLeft = hudRight - panelWidth + panelDragOffset.x
  const adjustedTop = (window.innerHeight - effectivePanelH) / 2 + screenYOffset + panelDragOffset.y

  return (
    <>
      {ghost}
      <div
        className="fleet-hud-wrap"
        ref={hudRef}
        style={{ left: panelLeft, top: adjustedTop, width: panelWidth, height: effectivePanelH }}
      >
        {/* 8 resize handles — corners + edges */}
        {RESIZE_HANDLES.map(h => (
          <div
            key={h.id}
            className="fleet-hud-resize-handle"
            style={{ cursor: h.cursor, ...h.style }}
            onPointerDown={e => onResizePointerDown(e, h.dy, effectivePanelH)}
            onPointerMove={onResizePointerMove}
            onPointerUp={onResizePointerUp}
          />
        ))}

        {/* Controls bar — drag handle for moving the panel */}
        <div
          ref={barRef}
          className="fleet-hud-controls"
          onPointerDown={onBarPointerDown}
          onPointerMove={onBarPointerMove}
          onPointerUp={onBarPointerUp}
        >
          <span className="fleet-hud-drag-indicator" title="Drag to move">⠿</span>
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
