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
const FLEET_SHAPE_TYPES_SET = new Set(FLEET_SHAPE_TYPES)

/** Mutable flag: true when the HUD overlay is expanded. Read by
 *  getShapeVisibility on the main editor to hide fleet shapes from
 *  hit-testing (they're rendered by the overlay instead). */
export const fleetHudOpenRef = { current: false }

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
  const overlayEditorRef = useRef<Editor | null>(null)
  // Camera offsets: initialized once on first expand, then frozen.
  // panOffsetRef (X): only updated by pan deltas, not zoom or shape moves.
  // cameraYRef (Y): set once, never updated by shape moves.
  const panOffsetRef = useRef<number | null>(null)
  const cameraYRef = useRef<number | null>(null)

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
    const isOpen = !!(expanded && fleetBounds)
    fleetHudOpenRef.current = isOpen
    if (isOpen) {
      document.body.classList.add('fleet-hud-open')
    } else {
      document.body.classList.remove('fleet-hud-open')
    }
    // Touch fleet shapes so tldraw's getShapeVisibility cache invalidates.
    // The cache is keyed on shape records — bumping meta triggers recomputation.
    const fleetShapes = mainEditor.getCurrentPageShapes()
      .filter(s => FLEET_SHAPE_TYPES_SET.has(s.type as string))
    if (fleetShapes.length > 0) {
      const tick = Date.now()
      mainEditor.updateShapes(fleetShapes.map(s => ({
        id: s.id, type: s.type, meta: { ...s.meta, _visTick: tick },
      })))
    }
    return () => {
      document.body.classList.remove('fleet-hud-open')
      fleetHudOpenRef.current = false
      // Touch again on close so shapes become visible in main editor
      const shapes = mainEditor.getCurrentPageShapes()
        .filter(s => FLEET_SHAPE_TYPES_SET.has(s.type as string))
      if (shapes.length > 0) {
        mainEditor.updateShapes(shapes.map(s => ({
          id: s.id, type: s.type, meta: { ...s.meta, _visTick: Date.now() },
        })))
      }
    }
  }, [expanded, fleetBounds, mainEditor])

  // Track main camera for pan: update panOffsetRef by screen-pixel deltas
  // when the user pans (cam.z unchanged). Zoom changes are ignored (fleet
  // shapes stay at their current screen positions).
  useEffect(() => {
    if (!expanded) return
    let rafId: number
    let lastCamX = mainEditor.getCamera().x
    let lastCamZ = mainEditor.getCamera().z
    const poll = () => {
      const cam = mainEditor.getCamera()
      if (cam.x !== lastCamX || cam.z !== lastCamZ) {
        if (cam.z === lastCamZ && panOffsetRef.current !== null) {
          // Pure pan: update offset by screen-pixel delta
          panOffsetRef.current += (cam.x - lastCamX) * cam.z
        }
        lastCamX = cam.x
        lastCamZ = cam.z
        setCameraTick(t => t + 1)
      }
      rafId = requestAnimationFrame(poll)
    }
    rafId = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(rafId)
  }, [mainEditor, expanded])

  // Block HTML5 file/chip drops on fleet shapes (except chat input areas).
  // With the full-viewport overlay, we check if the drop target is inside
  // an actual fleet shape, not the HUD bounding rect.
  // Drops onto chat input areas are allowed (file attachments).
  // Drops on empty canvas (not on a fleet shape) pass through to tldraw.
  useEffect(() => {
    if (!expanded) return
    const isInsideFleetShape = (clientX: number, clientY: number) => {
      const target = document.elementFromPoint(clientX, clientY)
      if (!target) return false
      return !!target.closest('[data-shape-type="fleet-chat"], [data-shape-type="fleet-agents"], [data-shape-type="fleet-search"], [data-shape-type="fleet-docview"]')
    }
    const isInsideChatInput = (e: DragEvent): boolean => {
      const target = document.elementFromPoint(e.clientX, e.clientY)
      if (!target) return false
      if (target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'hidden')) return true
      return !!target.closest('.fleet-chat-input-area')
    }
    const onDragOver = (e: DragEvent) => {
      if (!isInsideFleetShape(e.clientX, e.clientY)) return
      if (isInsideChatInput(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const onDrop = (e: DragEvent) => {
      if (!isInsideFleetShape(e.clientX, e.clientY)) return
      if (isInsideChatInput(e)) return
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
  // Reset camera refs so the overlay re-centers on the new shapes.
  useEffect(() => {
    const onReset = () => {
      panOffsetRef.current = null
      cameraYRef.current = null
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

  // Fleet shapes rendered at z=1 (fixed size). X position computed dynamically
  // from document's screen position each render. Y frozen on first expand.
  void cameraTick

  // Camera offsets: computed once on first expand from the document's
  // current screen position, then frozen. X tracks pan only (no zoom).
  // Y is fixed after initial layout.
  const MARGIN_GAP = 20
  const TOP_PAD = 80

  if (panOffsetRef.current === null) {
    // Compute initial X: fleet right edge sits MARGIN_GAP px left of
    // the document's left margin at the current camera position.
    const docShapes = mainEditor.getCurrentPageShapes().filter(s =>
      (s.type as string) === 'html-page' || (s.type as string) === 'svg-page')
    let docLeftScreen = window.innerWidth / 2
    if (docShapes.length > 0) {
      let minPageX = Infinity
      for (const s of docShapes) {
        const b = mainEditor.getShapePageBounds(s.id)
        if (b && b.x < minPageX) minPageX = b.x
      }
      docLeftScreen = mainEditor.pageToScreen({ x: minPageX, y: 0 }).x
    }
    const fleetRightPage = fleetBounds.x + fleetBounds.w
    panOffsetRef.current = docLeftScreen - MARGIN_GAP - fleetRightPage
    cameraYRef.current = TOP_PAD - fleetBounds.y
  }

  const overlayCam = {
    x: panOffsetRef.current,
    y: cameraYRef.current!,
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
          onEditorMount={(e) => { overlayEditorRef.current = e }}
          className="fleet-hud"
        />
      </div>
    </>
  )
}
