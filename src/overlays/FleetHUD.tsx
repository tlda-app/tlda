/**
 * FleetHUD — toggle pill in bottom-left that expands to a full-viewport
 * transparent overlay showing fleet shapes via CanvasClipPanel.
 *
 * The overlay covers the entire screen. Fleet shapes render at their canvas
 * positions mapped to screen via a camera with z=1. Horizontal position tracks
 * the main canvas (pans with the document); vertical position is fixed.
 * Pointer events pass through to the main canvas for non-fleet areas.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { useFleetAgents } from '../fleet-data-adapter'
import { dropGhostState, dropGhostBus } from '../shapes/FleetPillShape'
import './FleetHUD.css'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview']

interface FleetHUDProps {
  mainEditor: Editor
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

/**
 * Repack remaining fleet shapes into a clean grid after a deletion.
 * Sorts shapes in reading order, computes a grid from the existing bounding
 * box, and resizes + repositions each shape to fill a cell.
 */
/** Anisotropic scale: normalize each shape's position and size relative to the
 *  current bounding box, then apply to the target bounding box. Preserves
 *  each shape's proportional position and size — no packing, no uniform cells. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function repackFleetShapes(editor: Editor, targetBounds?: { x: number; y: number; w: number; h: number }) {
  const shapes = editor.getCurrentPageShapes()
    .filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
  if (shapes.length === 0) return

  // Current bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of shapes) {
    const b = editor.getShapePageBounds(s.id)
    if (!b) continue
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  if (!isFinite(minX)) return

  const srcW = maxX - minX || 1
  const srcH = maxY - minY || 1
  const tgt = targetBounds || { x: minX, y: minY, w: srcW, h: srcH }

  const updates: any[] = []
  for (const s of shapes) {
    const b = editor.getShapePageBounds(s.id)
    if (!b) continue
    const relX = (b.x - minX) / srcW
    const relY = (b.y - minY) / srcH
    const relW = b.w / srcW
    const relH = b.h / srcH
    updates.push({
      id: s.id,
      type: s.type,
      x: tgt.x + relX * tgt.w,
      y: tgt.y + relY * tgt.h,
      props: { w: Math.round(relW * tgt.w), h: Math.round(relH * tgt.h) },
    })
  }

  editor.updateShapes(updates)
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
      // Prefer screenRect set by the HUD editor — it used the HUD camera to
      // convert page→screen, so the ghost lands in the HUD's viewport rather
      // than wherever the main canvas would render the same page coordinates.
      if (dropGhostState.screenRect) {
        setGhost(dropGhostState.screenRect)
        return
      }
      // Fallback: convert via main editor (correct when drag originates on
      // the main canvas, not inside the HUD panel).
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
  // Camera tick used to recompute canvas→screen for the render on camera change
  const [cameraTick, setCameraTick] = useState(0)
  const agents = useFleetAgents()
  const hudRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  // Reactively update fleet bounds when shapes change.
  //
  // Position updates: freeze during USER drag (so the auto-zoom panel doesn't
  // thrash mid-resize), recalculate on pointerup. Updates from remote sync
  // (Yjs from another tab or the server) recalculate IMMEDIATELY — those
  // aren't drags and deferring them caused a nasty bug where the HUD would
  // appear to "spontaneously zoom" minutes later when the user happened to
  // click anywhere on the page (which fired the deferred handler).
  useEffect(() => {
    setFleetBounds(getFleetBounds(mainEditor))

    const unsub = mainEditor.store.listen(({ changes }) => {
      const isFleetChange = (record: any) =>
        record.typeName === 'shape' && FLEET_SHAPE_TYPES.includes(record.type)

      // Immediate: add/remove always recalculates
      const hasAddition = Object.values(changes.added).some(isFleetChange)
      const hasRemoval = Object.values(changes.removed).some(isFleetChange)
      const hasAddOrRemove = hasAddition || hasRemoval

      if (hasAddOrRemove) {
        draggingRef.current = false
        setFleetBounds(getFleetBounds(mainEditor))
        // Auto-reflow disabled — it was making things worse, not better.
        // TODO: reimplement add+delete-as-identity later. For now shapes
        // stay where they are on add/remove; user drags manually.
        return
      }

      // Position/size updates
      const hasUpdate = Object.values(changes.updated)
        .some(([from, to]) => isFleetChange(from) || isFleetChange(to))

      if (!hasUpdate) return

      // Only defer if the user is actively dragging (pointer is down inside
      // tldraw). For programmatic/remote updates, recalc immediately so the
      // HUD reflects the new bounds at the moment they change.
      const isUserDragging = !!mainEditor.inputs?.isPointing
      if (isUserDragging) {
        draggingRef.current = true
      } else {
        draggingRef.current = false
        setFleetBounds(getFleetBounds(mainEditor))
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

  // Track camera so render recomputes canvas→screen projection for HUD x.
  // We poll via rAF because tldraw camera changes don't fire store listeners
  // on the same scope we care about.
  useEffect(() => {
    if (!expanded) return
    let rafId: number
    let lastCamX = mainEditor.getCamera().x
    let lastCamZ = mainEditor.getCamera().z
    const poll = () => {
      const cam = mainEditor.getCamera()
      if (cam.x !== lastCamX || cam.z !== lastCamZ) {
        lastCamX = cam.x
        lastCamZ = cam.z
        setCameraTick(t => t + 1)
      }
      rafId = requestAnimationFrame(poll)
    }
    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [mainEditor, expanded])

  // Refuse HTML5 file/chip drops anywhere inside the HUD rectangle. The HUD
  // wrap itself has pointer-events: none, so we can't put handlers on it; use
  // capture-phase document listeners and check the cursor against the HUD's
  // current bounding rect. Without this, dropping a markdown chip into the
  // HUD area wedges the drag-over machinery somewhere downstream.
  //
  // Exception: drops onto chat input areas (textarea, input elements, or
  // anything inside .fleet-chat-input-area) are allowed through so the user
  // can drop image/file attachments into the chat composer.
  useEffect(() => {
    if (!expanded) return
    const isInsideHud = (clientX: number, clientY: number) => {
      const el = hudRef.current
      if (!el) return false
      const r = el.getBoundingClientRect()
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
    }
    const isInsideChatInput = (e: DragEvent): boolean => {
      // Check the actual element under the cursor — if it's a text input or
      // inside the chat composer area, let the drop fall through.
      const target = document.elementFromPoint(e.clientX, e.clientY)
      if (!target) return false
      if (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'hidden')) return true
      return !!target.closest('.fleet-chat-input-area')
    }
    const onDragOver = (e: DragEvent) => {
      if (!isInsideHud(e.clientX, e.clientY)) return
      if (isInsideChatInput(e)) return  // allow — chat composer handles it
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const onDrop = (e: DragEvent) => {
      if (!isInsideHud(e.clientX, e.clientY)) return
      if (isInsideChatInput(e)) return  // allow — chat composer handles it
      e.preventDefault()
      e.stopPropagation()
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    return () => {
      document.removeEventListener('dragover', onDragOver, true)
      document.removeEventListener('drop', onDrop, true)
    }
  }, [expanded])

  const aliveCount = useMemo(() => {
    return agents.filter((a: any) => !a.dead && !a.human).length
  }, [agents])

  // Emergency reset: when the Fleet button in the TOC is clicked, it
  // recreates the fleet shapes AND fires a `fleet-hud-reset` event.
  useEffect(() => {
    const onReset = () => {
      setFleetBounds(getFleetBounds(mainEditor))
    }
    window.addEventListener('fleet-hud-reset', onReset)
    return () => window.removeEventListener('fleet-hud-reset', onReset)
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

  // Expanded: CanvasClipPanel with fleet region.
  //
  // Full-viewport overlay: the HUD covers the entire screen with a transparent
  // overlay. Fleet shapes render at their canvas positions mapped to screen via
  // a camera with z=1. Horizontal position tracks the main canvas (pans with
  // the document); vertical position is fixed (shapes stay at their screen row).
  //
  // Camera math (z=1):
  //   screenX = canvasX + camX  → camX adjusts so shapes track doc horizontally
  //   screenY = canvasY + camY  → camY is fixed so shapes don't scroll vertically
  //
  // For horizontal tracking with the document, we want the fleet shapes to
  // appear at the same screen X as they would on the main canvas:
  //   mainScreenX = (canvasX + mainCam.x) * mainCam.z
  //   overlayScreenX = canvasX + camX
  //   Setting equal: camX = canvasX * (mainCam.z - 1) + mainCam.x * mainCam.z
  // This depends on canvasX, so we use the fleet bounds center as reference.
  // Shapes near the center track perfectly; distant shapes drift slightly.
  //
  // For vertical lock: camY = desiredScreenY - fleetCenter.y
  // desiredScreenY = viewport center minus half the fleet height, or stored override.
  void cameraTick
  const cam = mainEditor.getCamera()
  const fbCenterX = fleetBounds.x + fleetBounds.w / 2
  const fbCenterY = fleetBounds.y + fleetBounds.h / 2

  // Desired screen Y for the fleet center — stored override or viewport center
  const desiredScreenY = hudOverride?.screenY ?? (window.innerHeight / 2)

  const overlayCam = {
    x: fbCenterX * (cam.z - 1) + cam.x * cam.z,
    y: desiredScreenY - fbCenterY,
    z: 1,
  }

  return (
    <>
      {ghost}
      <div
        className="fleet-hud-wrap"
        ref={hudRef}
        style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}
      >
        <div className="fleet-hud-controls" style={{ position: 'fixed', top: 4, left: 4 }}>
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
          panelWidth={window.innerWidth}
          maxHeightFraction={1}
          lockCamera={true}
          liveEdit={true}
          cameraOverride={overlayCam}
          fullViewport={true}
          className="fleet-hud"
        />
      </div>
    </>
  )
}
