/**
 * FleetHUD — toggle pill in bottom-left that expands to a full-viewport
 * transparent overlay showing fleet shapes via CanvasClipPanel.
 *
 * The overlay covers the entire screen. Fleet shapes render at their canvas
 * positions mapped to screen via a camera with z=1. Position is derived from
 * the HUD anchor shape (shape:fleet-hud-anchor) stored in Yjs. The anchor
 * encodes the desired screen position of the overlay — updated on every camera
 * change to keep pageToScreen(anchor) constant, fixing fleet shapes at constant
 * screen positions regardless of document panning or zoom.
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

/** Anisotropic scale: normalize each shape's position and size relative to the
 *  current bounding box, then apply to the target bounding box. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function repackFleetShapes(editor: Editor, targetBounds?: { x: number; y: number; w: number; h: number }) {
  const shapes = editor.getCurrentPageShapes()
    .filter(s => FLEET_SHAPE_TYPES.includes(s.type as string))
  if (shapes.length === 0) return

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of shapes) {
    const b = editor.getShapePageBounds(s.id)
    if (!b) continue
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w); maxY = Math.max(maxY, b.y + b.h)
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
      id: s.id, type: s.type,
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
    minX = Math.min(minX, bounds.x); minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.w); maxY = Math.max(maxY, bounds.y + bounds.h)
  }
  if (!isFinite(minX)) return null

  const PAD = 20
  return { x: minX - PAD, y: minY - PAD, w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 }
}

export function FleetHUD({ mainEditor, shapeUtils, tools, licenseKey }: FleetHUDProps) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem('fleet-hud-expanded') === '1')
  const [fleetBounds, setFleetBounds] = useState<ClipBounds | null>(() => getFleetBounds(mainEditor))
  // cameraTick triggers re-render when camera changes so overlayCam recomputes
  const [cameraTick, setCameraTick] = useState(0)
  const agents = useFleetAgents()
  const hudRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const overlayEditorRef = useRef<Editor | null>(null)
  const FLEET_TYPES_HUD = new Set(['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview'])

  // Anchor-based position: local ref tracks the anchor's page coords at the
  // CURRENT camera. The anchor shape also carries meta.{cameraX,cameraY,cameraZ}
  // — the camera at which it was last saved. On every load (even if TLDraw
  // temporarily restores a stale local-persistence camera before Yjs overwrites
  // it), we reconstruct the anchor's invariant screen position from meta, then
  // convert to the current camera's page coords. This prevents the right-shift bug.
  const anchorPageRef = useRef<{ x: number; y: number } | null>(null)
  const fleetBoundsRef = useRef(fleetBounds)
  fleetBoundsRef.current = fleetBounds

  // Reactively update fleet bounds when shapes change.
  useEffect(() => {
    setFleetBounds(getFleetBounds(mainEditor))

    const unsub = mainEditor.store.listen(({ changes }) => {
      const isFleetChange = (record: any) =>
        record.typeName === 'shape' && FLEET_SHAPE_TYPES.includes(record.type)

      const hasAddition = Object.values(changes.added).some(isFleetChange)
      const hasRemoval = Object.values(changes.removed).some(isFleetChange)
      if (hasAddition || hasRemoval) {
        draggingRef.current = false
        setFleetBounds(getFleetBounds(mainEditor))
        return
      }

      const hasUpdate = Object.values(changes.updated)
        .some(([from, to]) => isFleetChange(from) || isFleetChange(to))
      if (!hasUpdate) return

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
    return () => { unsub(); window.removeEventListener('pointerup', handlePointerUp, true) }
  }, [mainEditor])

  // Watch for anchor shape creation/update from Yjs (createFleetLayout or another tab).
  // Refresh anchorPageRef when the anchor is added or significantly repositioned.
  // Uses meta.{cameraX,cameraY,cameraZ} to reconstruct screen position regardless
  // of what the current camera is — safe even during TLDraw's pre-Yjs camera restore.
  useEffect(() => {
    const adoptAnchor = (anchor: any, why: string) => {
      const cam = mainEditor.getCamera()
      const meta = anchor.meta || {}
      // Reference camera: what the anchor's page coords are relative to.
      // Falls back to current camera for anchors created before meta was added.
      const refCamX = typeof meta.cameraX === 'number' ? meta.cameraX : cam.x
      const refCamY = typeof meta.cameraY === 'number' ? meta.cameraY : cam.y
      const refCamZ = typeof meta.cameraZ === 'number' ? meta.cameraZ : cam.z
      // Reconstruct screen position using reference camera, then convert to current camera
      const screenX = (anchor.x + refCamX) * refCamZ
      const screenY = (anchor.y + refCamY) * refCamZ
      anchorPageRef.current = { x: screenX / cam.z - cam.x, y: screenY / cam.z - cam.y }
    }

    const existing = mainEditor.getShape(FLEET_HUD_ANCHOR_ID as any) as any
    if (existing && anchorPageRef.current === null) adoptAnchor(existing, 'mount')

    const unsub = mainEditor.store.listen(({ changes }) => {
      const added = Object.values(changes.added).find((r: any) => r.id === FLEET_HUD_ANCHOR_ID) as any
      if (added) {
        adoptAnchor(added, 'added')
        setCameraTick(t => t + 1)
        return
      }
      const updated = Object.values(changes.updated)
        .map(([, to]) => to as any)
        .find((r: any) => r.id === FLEET_HUD_ANCHOR_ID)
      if (updated && anchorPageRef.current !== null) {
        const dx = Math.abs(updated.x - anchorPageRef.current.x)
        const dy = Math.abs(updated.y - anchorPageRef.current.y)
        // Only adopt remote repositioning (layout reset) — ignore our own debounced persists
        if (dx > 10 || dy > 10) {
          adoptAnchor(updated, 'updated-remote')
          setCameraTick(t => t + 1)
        }
      }
    }, { source: 'all', scope: 'document' })

    return unsub
  }, [mainEditor])

  useEffect(() => {
    const isOpen = !!(expanded && fleetBounds)
    fleetHudOpenRef.current = isOpen
    if (isOpen) document.body.classList.add('fleet-hud-open')
    else document.body.classList.remove('fleet-hud-open')
    return () => { document.body.classList.remove('fleet-hud-open'); fleetHudOpenRef.current = false }
  }, [expanded, fleetBounds])

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

  // Camera tracking: keep anchorPageRef stable in screen space as the camera changes.
  // Settle detection (2 stable frames) guards against re-expressing during rapid
  // camera transitions. The meta-camera in the anchor handles the initial-load case.
  useEffect(() => {
    if (!expanded) return
    let rafId: number
    let lastCamX = mainEditor.getCamera().x
    let lastCamY = mainEditor.getCamera().y
    let lastCamZ = mainEditor.getCamera().z
    let stableFrames = 0
    let persistTimeout: ReturnType<typeof setTimeout> | null = null

    const persistAnchor = () => {
      if (!anchorPageRef.current) return
      const existing = mainEditor.getShape(FLEET_HUD_ANCHOR_ID as any)
      if (existing) {
        const cam = mainEditor.getCamera()
        mainEditor.updateShape({ id: FLEET_HUD_ANCHOR_ID as any, type: 'geo', isLocked: false })
        mainEditor.updateShape({
          id: FLEET_HUD_ANCHOR_ID as any, type: 'geo', isLocked: true,
          x: anchorPageRef.current.x, y: anchorPageRef.current.y,
          meta: { cameraX: cam.x, cameraY: cam.y, cameraZ: cam.z },
        })
      }
    }

    const poll = () => {
      const cam = mainEditor.getCamera()
      if (cam.x !== lastCamX || cam.y !== lastCamY || cam.z !== lastCamZ) {
        if (anchorPageRef.current !== null && stableFrames >= 2) {
          // Re-express Y only: keep fleet shapes at a fixed screen Y as the camera scrolls.
          // X is not re-expressed — it follows the canvas naturally (fleet shapes pan with the doc).
          const screenY = (anchorPageRef.current.y + lastCamY) * lastCamZ
          anchorPageRef.current = { x: anchorPageRef.current.x, y: screenY / cam.z - cam.y }
          if (persistTimeout) clearTimeout(persistTimeout)
          persistTimeout = setTimeout(persistAnchor, 500)
        }
        stableFrames = 0
        lastCamX = cam.x; lastCamY = cam.y; lastCamZ = cam.z
        setCameraTick(t => t + 1)
      } else {
        stableFrames = Math.min(stableFrames + 1, 100)
        // After settling: migrate old anchors that lack meta.camera, and initialize
        // anchorPageRef if not yet set (e.g., anchor arrived before camera settled).
        if (stableFrames === 3) {
          const anchor = mainEditor.getShape(FLEET_HUD_ANCHOR_ID as any) as any
          if (anchor && !anchor.meta?.cameraX) {
            // Anchor exists but lacks reference camera — resynthesize from document.
            // Store listener picks up the update via changes.updated → adoptAnchor.
            _synthesizeAnchor(mainEditor, fleetBoundsRef.current)
          } else if (!anchor && anchorPageRef.current === null) {
            _synthesizeAnchor(mainEditor, fleetBoundsRef.current)
            // Store listener will pick up the new shape and set anchorPageRef
          } else if (anchor && anchorPageRef.current === null) {
            // Has meta but adoptAnchor hasn't run yet (race: anchor arrived before effect)
            anchorPageRef.current = { x: anchor.x, y: anchor.y }
            setCameraTick(t => t + 1)
          }
        }
      }
      rafId = requestAnimationFrame(poll)
    }
    rafId = requestAnimationFrame(poll)
    return () => { cancelAnimationFrame(rafId); if (persistTimeout) clearTimeout(persistTimeout) }
  }, [mainEditor, expanded])

  // Block HTML5 file/chip drops on fleet shapes (except chat input areas).
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
      e.preventDefault(); e.stopPropagation()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    const onDrop = (e: DragEvent) => {
      if (!isInsideFleetShape(e.clientX, e.clientY)) return
      if (isInsideChatInput(e)) return
      e.preventDefault(); e.stopPropagation()
    }
    document.addEventListener('dragover', onDragOver, true)
    document.addEventListener('drop', onDrop, true)
    return () => { document.removeEventListener('dragover', onDragOver, true); document.removeEventListener('drop', onDrop, true) }
  }, [expanded])

  // Toggle .hud-layout-active when fleet shapes are selected in the HUD editor.
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
        fleetLayoutActiveRef.current = true
        el.classList.add('hud-layout-active')
      }
    }

    let rafId: number
    let unsub: (() => void) | null = null
    const onPointerUp = () => checkSelection()
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
      })
    }
    const trySubscribe = () => {
      if (overlayEditorRef.current) {
        checkSelection()
        unsub = overlayEditorRef.current.store.listen(({ changes }) => {
          for (const [, to] of Object.values(changes.updated)) {
            const typeName = (to as any).typeName
            if (typeName === 'instance_page_state') { checkSelection(); return }
            if (typeName === 'instance' && (to as any).brush == null) { checkSelection(); return }
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
      cancelAnimationFrame(rafId); unsub?.()
      el.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointerup', onWindowPointerUp, true)
      if (!expanded) { fleetLayoutActiveRef.current = false; el.classList.remove('hud-layout-active') }
    }
  }, [expanded])

  const aliveCount = useMemo(() => agents.filter((a: any) => !a.dead && !a.human).length, [agents])
  void aliveCount

  useEffect(() => {
    const onToggle = () => setExpanded(prev => {
      const next = !prev
      localStorage.setItem('fleet-hud-expanded', next ? '1' : '0')
      return next
    })
    window.addEventListener('fleet-hud-toggle', onToggle)
    return () => window.removeEventListener('fleet-hud-toggle', onToggle)
  }, [])

  if (!fleetBounds) return null
  if (!expanded) return null

  void cameraTick

  // Anchor not yet initialized — wait for Yjs sync or camera settle
  if (!anchorPageRef.current) return null

  // Derive overlay camera: mixed anchoring.
  // Y: fixed in screen space — anchorPageRef.y is re-expressed on scroll to maintain constant
  //    screen Y, so anchorScreenY never changes with vertical camera movement.
  // X: follows the canvas — anchorPageRef.x is NOT re-expressed, so the anchor's canvas X is
  //    fixed. As cam.x changes, anchorScreenX changes by the same amount → panel pans with doc.
  const cam = mainEditor.getCamera()
  const anchorScreenX = (anchorPageRef.current.x + cam.x) * cam.z
  const anchorScreenY = (anchorPageRef.current.y + cam.y) * cam.z
  const overlayCam = {
    x: anchorScreenX - fleetBounds.x,
    y: anchorScreenY - fleetBounds.y,
    z: 1,
  }

  return (
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
  )
}

/**
 * Synthesize (create or update) the HUD anchor from the current fleet layout and camera.
 * Called when no anchor exists, or when an anchor lacks meta.camera (migration).
 * Computes position from document + fleet shape geometry directly from the editor store.
 */
function _synthesizeAnchor(editor: Editor) {
  const cam = editor.getCamera()
  const PAD = 20
  const TOP_PAD = 80
  const MARGIN_GAP = 20

  // Compute fleet bounds directly from store (don't rely on React state)
  const fleetShapeTypes = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview']
  const fleetShapes = editor.getCurrentPageShapes()
    .filter(s => fleetShapeTypes.includes(s.type as string))
  if (fleetShapes.length === 0) return

  let minX = Infinity, minY = Infinity, maxX = -Infinity
  for (const s of fleetShapes) {
    const b = editor.getShapePageBounds(s.id)
    if (!b) continue
    if (b.x < minX) minX = b.x; if (b.y < minY) minY = b.y
    if (b.x + b.w > maxX) maxX = b.x + b.w
  }
  if (!isFinite(minX)) return

  const fleetBoundsX = minX - PAD
  const fleetBoundsY = minY - PAD

  let overlayCamX: number
  let overlayCamY: number

  const storedPan = localStorage.getItem('fleet-hud-panOffset')
  const storedCamY = localStorage.getItem('fleet-hud-cameraY')

  if (storedPan !== null) {
    overlayCamX = parseFloat(storedPan)
    overlayCamY = storedCamY !== null ? parseFloat(storedCamY) : TOP_PAD - fleetBoundsY
    localStorage.removeItem('fleet-hud-panOffset')
    localStorage.removeItem('fleet-hud-cameraY')
  } else {
    const docShapes = editor.getCurrentPageShapes()
      .filter(s => (s.type as string) === 'html-page' || (s.type as string) === 'svg-page')
    let minPageX = Infinity
    for (const s of docShapes) {
      const b = editor.getShapePageBounds(s.id)
      if (b && b.x < minPageX) minPageX = b.x
    }
    if (!isFinite(minPageX)) return
    const docLeftScreen = editor.pageToScreen({ x: minPageX, y: 0 }).x
    const rights = fleetShapes.map(s => {
      const b = editor.getShapePageBounds(s.id)
      return b ? b.x + b.w : 0
    })
    const leftGroupShapes = rights.filter(r => r - minX < 1500)
    const leftGroupRight = leftGroupShapes.length > 0 ? Math.max(...leftGroupShapes) : maxX
    overlayCamX = docLeftScreen - MARGIN_GAP - leftGroupRight
    overlayCamY = TOP_PAD - fleetBoundsY
  }

  // TLDraw: screenX = (pageX + cam.x) * cam.z  →  pageX = screenX / cam.z - cam.x
  const anchorScreenX = overlayCamX + fleetBoundsX
  const anchorScreenY = overlayCamY + fleetBoundsY
  const anchorShapeX = anchorScreenX / cam.z - cam.x
  const anchorShapeY = anchorScreenY / cam.z - cam.y

  const existingAnchor = editor.getShape(FLEET_HUD_ANCHOR_ID as any)
  if (existingAnchor) {
    editor.updateShape({ id: FLEET_HUD_ANCHOR_ID as any, type: 'geo', isLocked: false })
    editor.updateShape({
      id: FLEET_HUD_ANCHOR_ID as any, type: 'geo', isLocked: true,
      x: anchorShapeX, y: anchorShapeY,
      meta: { cameraX: cam.x, cameraY: cam.y, cameraZ: cam.z },
    })
  } else {
    editor.createShape({
      id: FLEET_HUD_ANCHOR_ID as any,
      type: 'geo',
      x: anchorShapeX,
      y: anchorShapeY,
      opacity: 0,
      isLocked: true,
      meta: { cameraX: cam.x, cameraY: cam.y, cameraZ: cam.z },
      props: { w: 1, h: 1, geo: 'rectangle' },
    })
  }
}
