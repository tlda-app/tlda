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
import { FLEET_HUD_ANCHOR_ID } from '../shapes/fleet-utils'
import './FleetHUD.css'

const FLEET_SHAPE_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview']
const FLEET_SHAPE_TYPES_SET = new Set(FLEET_SHAPE_TYPES)

/** Mutable flag: true when the HUD overlay is expanded. Read by
 *  getShapeVisibility on the main editor to hide fleet shapes from
 *  hit-testing (they're rendered by the overlay instead). */
export const fleetHudOpenRef = { current: false }

/** True when layout mode is active (fleet shapes are selectable/draggable).
 *  Read by BrowseIdle's _deselHandler to skip selectNone during layout.
 *  Separate from the CSS class to avoid circular dependency. */
export const fleetLayoutActiveRef = { current: false }

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
  const FLEET_TYPES_HUD = new Set(['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview'])

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
  // Body class + visibility ref (no shape updates here — that causes loops
  // since updating shapes triggers fleetBounds recalc which re-runs this effect)
  useEffect(() => {
    const isOpen = !!(expanded && fleetBounds)
    fleetHudOpenRef.current = isOpen
    if (isOpen) {
      document.body.classList.add('fleet-hud-open')
    } else {
      document.body.classList.remove('fleet-hud-open')
    }
    return () => {
      document.body.classList.remove('fleet-hud-open')
      fleetHudOpenRef.current = false
    }
  }, [expanded, fleetBounds])

  // Touch fleet shapes to invalidate getShapeVisibility cache — only when
  // expanded state actually changes, not on every fleetBounds update.
  const prevExpandedRef = useRef(false)
  useEffect(() => {
    const isOpen = !!(expanded && fleetBounds)
    if (isOpen === prevExpandedRef.current) return
    prevExpandedRef.current = isOpen
    const fleetShapes = mainEditor.getCurrentPageShapes()
      .filter(s => FLEET_SHAPE_TYPES_SET.has(s.type as string))
    if (fleetShapes.length > 0) {
      const tick = Date.now()
      mainEditor.updateShapes(fleetShapes.map(s => ({
        id: s.id, type: s.type, meta: { ...s.meta, _visTick: tick },
      })))
    }
  }, [expanded, fleetBounds, mainEditor])

  // Re-render on camera changes so the overlay camera recomputes from the
  // anchor shape's current screen position.
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

  // Toggle .hud-layout-active on the wrap div when fleet shapes are selected
  // in the HUD editor. This enables pointer-events on .tl-canvas so drag-box
  // select works — but ONLY when the user has already clicked ⊞ to enter layout
  // mode. Normal browsing (nothing selected) keeps the canvas pointer-events: none
  // so empty-area clicks pass through to the main canvas as always.
  useEffect(() => {
    if (!expanded) return
    const el = hudRef.current
    if (!el) return

    const checkSelection = () => {
      const editor = overlayEditorRef.current
      if (!editor) return
      const hasFleetSelected = editor.getSelectedShapeIds().some(id => {
        const s = editor.getShape(id as any)
        return s && FLEET_TYPES_HUD.has(s.type as string)
      })
      if (hasFleetSelected) {
        // ADD immediately — user selected a fleet shape, enable interaction
        fleetLayoutActiveRef.current = true
        el.classList.add('hud-layout-active')
      }
      // REMOVAL is handled by BrowseIdle.onEnter — never from here.
      // Removing from a store listener races with TLDraw's state machine
      // and kills pointer-events mid-interaction.
    }

    // Poll via RAF until overlayEditorRef is set, then switch to store listener
    let rafId: number
    let unsub: (() => void) | null = null
    const onPointerUp = () => checkSelection()
    // HACK: Safety valve — if pointer-events:none was restored mid-drag
    // (e.g. class removed by a React re-render), TLDraw never sees pointerup
    // and stays stuck in brushing/pointing_canvas with isPointing=true.
    // On any window pointerup, if the overlay editor is still "pointing" AND
    // the canvas is blocked (pointer-events:none), force-dispatch pointer_up.
    // Guard: if the canvas is pointer-events:auto (hud-layout-active), TLDraw
    // will receive the native pointerup itself — dispatching here causes a
    // double pointer_up that fires selectOnCanvasPointerUp in idle state,
    // clearing the brush selection immediately after it completes.
    const onWindowPointerUp = (e: PointerEvent) => {
      const editor = overlayEditorRef.current
      if (!editor) return
      if (!editor.inputs.isPointing) return
      const canvas = el.querySelector('.tl-canvas')
      if (canvas && getComputedStyle(canvas).pointerEvents !== 'none') return
      editor.dispatch({
        type: 'pointer', name: 'pointer_up', target: 'canvas',
        pointerId: e.pointerId, point: { x: e.clientX, y: e.clientY, z: 0.5 },
        shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey,
        metaKey: e.metaKey, button: e.button, buttons: e.buttons,
      } as any)
    }
    const trySubscribe = () => {
      if (overlayEditorRef.current) {
        checkSelection()
        unsub = overlayEditorRef.current.store.listen(({ changes }) => {
          for (const [, to] of Object.values(changes.updated)) {
            const typeName = (to as any).typeName
            if (typeName === 'instance_page_state') {
              checkSelection()
              return
            }
            if (typeName === 'instance' && (to as any).brush == null) {
              checkSelection()
              return
            }
          }
        }, { scope: 'session', source: 'all' })
        el.addEventListener('pointerup', onPointerUp, true)
        window.addEventListener('pointerup', onWindowPointerUp, true)
      } else {
        rafId = requestAnimationFrame(trySubscribe)
      }
    }
    trySubscribe()

    return () => {
      cancelAnimationFrame(rafId)
      unsub?.()
      el.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointerup', onWindowPointerUp, true)
      // Only clear layout mode when the HUD is actually closing (expanded going false).
      if (!expanded) {
        fleetLayoutActiveRef.current = false
        el.classList.remove('hud-layout-active')
      }
    }
  }, [expanded])

  const aliveCount = useMemo(() => agents.filter((a: any) => !a.dead && !a.human).length, [agents])
  void aliveCount

  useEffect(() => {
    const onReset = () => setFleetBounds(getFleetBounds(mainEditor))
    const onToggle = () => setExpanded(prev => {
      const next = !prev
      localStorage.setItem('fleet-hud-expanded', next ? '1' : '0')
      return next
    })
    window.addEventListener('fleet-hud-reset', onReset)
    window.addEventListener('fleet-hud-toggle', onToggle)
    return () => {
      window.removeEventListener('fleet-hud-reset', onReset)
      window.removeEventListener('fleet-hud-toggle', onToggle)
    }
  }, [mainEditor])

  if (!fleetBounds) return null
  if (!expanded) return null

  void cameraTick

  const MARGIN_GAP = 20
  const TOP_PAD = 80

  // Derive overlay camera from the anchor shape's screen position.
  // X: tracks the anchor (moves with document pan/zoom).
  // Y: fixed at TOP_PAD in screen space.
  const anchorShape = mainEditor.getShape(FLEET_HUD_ANCHOR_ID as any)
  if (!anchorShape) return null

  const cam = mainEditor.getCamera()
  const anchorScreenX = (anchorShape.x + cam.x) * cam.z

  // Left group right edge — shapes within 1500px of the leftmost fleet shape.
  const fleetShapes = mainEditor.getCurrentPageShapes()
    .filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
  let leftGroupRight = fleetBounds.x + fleetBounds.w
  if (fleetShapes.length > 0) {
    const rights = fleetShapes.map(s => {
      const b = mainEditor.getShapePageBounds(s.id)
      return b ? b.x + b.w : 0
    })
    const leftGroupShapes = rights.filter(r => r - fleetBounds.x < 1500)
    if (leftGroupShapes.length > 0) leftGroupRight = Math.max(...leftGroupShapes)
  }

  const overlayCam = {
    x: anchorScreenX - MARGIN_GAP - leftGroupRight,
    y: TOP_PAD - fleetBounds.y,
    z: 1,
  }

  return (
    <>
      <div
        className="fleet-hud-wrap"
        ref={hudRef}
        style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}
      >
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
          onEditorMount={(e) => { overlayEditorRef.current = e; (window as any).__tldraw_hud_editor__ = e }}
          className="fleet-hud"
        />
      </div>
    </>
  )
}
