/**
 * FleetHUD — toggle pill in bottom-left that expands to show fleet shapes
 * region (chat + agents) via CanvasClipPanel.
 *
 * Two repositioning mechanisms:
 *   1. Controls bar drag (always available): grab the ⊞/× bar to move the whole HUD.
 *      Y → screenYOffset (persisted), X → canvas shape positions.
 *   2. Edit shapes mode (⊞ toggle): disables HTML pointer-events so tldraw's
 *      select tool can drag individual fleet shapes. Click ⊞ again to exit.
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

export function FleetHUD({
  mainEditor,
  shapeUtils,
  tools,
  licenseKey,
}: FleetHUDProps) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem('fleet-hud-expanded') === '1')
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => getFleetBounds(mainEditor))
  // Edit shapes mode: disables HTML content pointer-events so tldraw can drag individual shapes
  const [editMode, setEditMode] = useState(false)
  // Screen-space Y offset for the HUD panel — vertical positioning in screen coords.
  const [screenYOffset, setScreenYOffset] = useState(() =>
    parseFloat(localStorage.getItem('fleet-hud-y-offset') || '0') || 0
  )
  // Live offset applied during a controls-bar drag (whole-panel move)
  const [panelDragOffset, setPanelDragOffset] = useState({ x: 0, y: 0 })
  const agents = useFleetAgents()
  const hudRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // Controls bar drag state (whole-HUD repositioning)
  const controlsDragRef = useRef<{ startX: number; startY: number } | null>(null)

  // Reactively update fleet bounds when shapes change.
  useEffect(() => {
    setFleetBounds(getFleetBounds(mainEditor))

    const unsub = mainEditor.store.listen(({ changes }) => {
      const isFleetChange = (record: any) =>
        record.typeName === 'shape' && FLEET_SHAPE_TYPES.includes(record.type)

      const hasAddOrRemove =
        Object.values(changes.added).some(isFleetChange) ||
        Object.values(changes.removed).some(isFleetChange)

      if (hasAddOrRemove) {
        draggingRef.current = false
        setFleetBounds(getFleetBounds(mainEditor))
        return
      }

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

  // Body class: hide fleet shapes in main canvas when HUD is expanded
  useEffect(() => {
    if (expanded && fleetBounds) {
      document.body.classList.add('fleet-hud-open')
    } else {
      document.body.classList.remove('fleet-hud-open')
    }
    return () => document.body.classList.remove('fleet-hud-open')
  }, [expanded, fleetBounds])

  // Body class: disable HTML pointer-events on shape content in edit mode
  // so tldraw's select tool can receive events for individual shape dragging.
  useEffect(() => {
    if (editMode) {
      document.body.classList.add('fleet-layout-active')
    } else {
      document.body.classList.remove('fleet-layout-active')
    }
    return () => document.body.classList.remove('fleet-layout-active')
  }, [editMode])

  // Esc exits edit mode
  useEffect(() => {
    if (!editMode) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditMode(false) }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [editMode])

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

  // --- Controls bar drag: move whole HUD panel ---

  const onControlsPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Don't intercept clicks on buttons
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
    controlsDragRef.current = { startX: e.clientX, startY: e.clientY }
    setPanelDragOffset({ x: 0, y: 0 })
  }, [])

  const onControlsPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!controlsDragRef.current) return
    const dx = e.clientX - controlsDragRef.current.startX
    const dy = e.clientY - controlsDragRef.current.startY
    setPanelDragOffset({ x: dx, y: dy })
  }, [])

  const onControlsPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!controlsDragRef.current) return
    const dx = e.clientX - controlsDragRef.current.startX
    const dy = e.clientY - controlsDragRef.current.startY
    controlsDragRef.current = null
    setPanelDragOffset({ x: 0, y: 0 })

    // Commit Y: update persistent screenYOffset
    if (Math.abs(dy) > 2) {
      setScreenYOffset(prev => {
        const next = prev + dy
        localStorage.setItem('fleet-hud-y-offset', String(next))
        return next
      })
    }

    // Commit X: move fleet shapes in canvas coordinates
    if (Math.abs(dx) > 2) {
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
  }, [mainEditor])

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
  const panelHeight = window.innerHeight * 0.8
  const zoom = panelHeight / fleetBounds.h
  const panelWidth = fleetBounds.w * zoom
  const panelLeft = hudRight - panelWidth
  const adjustedTop = (window.innerHeight - panelHeight) / 2 + screenYOffset

  return (
    <>
      {ghost}
      <div
        className="fleet-hud-wrap"
        ref={hudRef}
        style={{
          left: panelLeft + panelDragOffset.x,
          top: adjustedTop + panelDragOffset.y,
        }}
      >
        <div
          className={`fleet-hud-controls${editMode ? ' fleet-hud-controls-edit' : ''}`}
          onPointerDown={onControlsPointerDown}
          onPointerMove={onControlsPointerMove}
          onPointerUp={onControlsPointerUp}
        >
          <button
            className={`fleet-hud-layout${editMode ? ' fleet-hud-layout-active' : ''}`}
            onClick={() => setEditMode(m => !m)}
            title={editMode ? 'Exit edit shapes mode' : 'Edit shapes / move HUD'}
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
