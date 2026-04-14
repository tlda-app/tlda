/**
 * HudLayoutMode — transient container overlay + layout mode for fleet shapes.
 *
 * When layout mode is activated:
 * 1. A React overlay (dashed border) appears around all fleet shapes — NOT a tldraw shape
 * 2. Resizing the overlay proportionally scales/repositions all fleet shapes
 * 3. Individual fleet shapes become plain movable/resizable rectangles
 * 4. Exiting layout mode removes the overlay; shapes stay where they are
 */
import {
  useEditor,
  type Editor,
  type TLShapeId,
} from 'tldraw'
import { useEffect, useState, useRef } from 'react'

// --- Layout mode global state ---
const FLEET_TYPES = ['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview']
const CONTAINER_PADDING = 20

let _layoutMode = false
const _listeners = new Set<() => void>()

export function isLayoutMode(): boolean {
  return _layoutMode
}

export function subscribeLayoutMode(cb: () => void): () => void {
  _listeners.add(cb)
  return () => { _listeners.delete(cb) }
}

function notifyListeners() {
  for (const cb of _listeners) cb()
}

export function useLayoutMode(): boolean {
  const [, setTick] = useState(0)
  useEffect(() => {
    return subscribeLayoutMode(() => setTick(t => t + 1))
  }, [])
  return _layoutMode
}

function getFleetShapes(editor: Editor) {
  return editor.getCurrentPageShapes().filter(s => FLEET_TYPES.includes(s.type))
}

export function toggleLayoutMode(_editor: Editor) {
  _layoutMode = !_layoutMode
  notifyListeners()
}

export function registerLayoutSideEffects(editor: Editor) {
  ;(window as any).__toggleLayoutMode__ = () => toggleLayoutMode(editor)
  ;(window as any).__isLayoutMode__ = () => _layoutMode
}

// --- Container Overlay ---

function getFleetBounds(editor: Editor): { x: number; y: number; w: number; h: number } | null {
  const fleetShapes = getFleetShapes(editor)
  if (fleetShapes.length === 0) return null

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of fleetShapes) {
    const bounds = editor.getShapePageBounds(s.id)
    if (!bounds) continue
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.w)
    maxY = Math.max(maxY, bounds.y + bounds.h)
  }

  if (minX === Infinity) return null
  return {
    x: minX - CONTAINER_PADDING,
    y: minY - CONTAINER_PADDING,
    w: (maxX - minX) + CONTAINER_PADDING * 2,
    h: (maxY - minY) + CONTAINER_PADDING * 2,
  }
}

const HANDLE_SIZE = 12
const HANDLES = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'right', 'bottom'] as const

// Module-level resize state — survives React re-renders
let _resizeState: {
  startX: number; startY: number
  startBounds: { x: number; y: number; w: number; h: number }
  handle: string
  snapshot: Map<string, { rx: number; ry: number; rw: number; rh: number }>
  editor: Editor
} | null = null

export function HudLayoutOverlay() {
  const editor = useEditor()
  const layoutMode = useLayoutMode()
  const [bounds, setBounds] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  // Suppress bounds updates while resizing (would cause recursive updates)
  const suppressBoundsUpdate = useRef(false)

  // Update bounds when layout mode is on and shapes change
  useEffect(() => {
    if (!layoutMode) {
      setBounds(null)
      return
    }

    const update = () => {
      if (suppressBoundsUpdate.current) return
      setBounds(getFleetBounds(editor))
    }
    update()

    const unsub = editor.store.listen(update, { scope: 'document' })
    return unsub
  }, [layoutMode, editor])

  // Single effect to install window-level capture listeners
  useEffect(() => {
    if (!layoutMode) return

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!target) return

      // Click outside the container → exit layout mode
      const overlay = overlayRef.current
      if (overlay && !overlay.contains(target)) {
        // Check the click isn't on a fleet shape (which is inside the container bounds
        // but rendered as a separate DOM element)
        const isFleetShape = target.closest('[data-shape-type="fleet-chat"], [data-shape-type="fleet-agents"], [data-shape-type="fleet-search"], [data-shape-type="fleet-docview"]')
        if (!isFleetShape) {
          e.stopImmediatePropagation()
          e.preventDefault()
          toggleLayoutMode(editor)
          return
        }
      }

      // Resize handle
      const handle = target.dataset?.handle
      if (!handle) return

      e.stopImmediatePropagation()
      e.preventDefault()

      const currentBounds = getFleetBounds(editor)
      if (!currentBounds) return

      const snapshot = new Map<string, { rx: number; ry: number; rw: number; rh: number }>()
      for (const s of getFleetShapes(editor)) {
        const sb = editor.getShapePageBounds(s.id)
        if (!sb) continue
        snapshot.set(s.id, {
          rx: (sb.x - currentBounds.x) / currentBounds.w,
          ry: (sb.y - currentBounds.y) / currentBounds.h,
          rw: sb.w / currentBounds.w,
          rh: sb.h / currentBounds.h,
        })
      }

      _resizeState = {
        startX: e.clientX,
        startY: e.clientY,
        startBounds: { ...currentBounds },
        handle,
        snapshot,
        editor,
      }
      suppressBoundsUpdate.current = true
    }

    function onPointerMove(e: PointerEvent) {
      const r = _resizeState
      if (!r) return

      e.stopImmediatePropagation()
      e.preventDefault()

      const zoom = r.editor.getCamera().z
      const dx = (e.clientX - r.startX) / zoom
      const dy = (e.clientY - r.startY) / zoom

      let newX = r.startBounds.x
      let newY = r.startBounds.y
      let newW = r.startBounds.w
      let newH = r.startBounds.h

      if (r.handle.includes('right')) newW = Math.max(200, r.startBounds.w + dx)
      if (r.handle.includes('left')) { newW = Math.max(200, r.startBounds.w - dx); newX = r.startBounds.x + (r.startBounds.w - newW) }
      if (r.handle.includes('bottom')) newH = Math.max(150, r.startBounds.h + dy)
      if (r.handle.includes('top')) { newH = Math.max(150, r.startBounds.h - dy); newY = r.startBounds.y + (r.startBounds.h - newH) }

      const updates: any[] = []
      for (const [id, rel] of r.snapshot) {
        const shape = r.editor.getShape(id as TLShapeId) as any
        if (!shape) continue
        updates.push({
          id: shape.id,
          type: shape.type,
          x: newX + rel.rx * newW,
          y: newY + rel.ry * newH,
          props: {
            ...shape.props,
            w: Math.max(100, rel.rw * newW),
            h: Math.max(80, rel.rh * newH),
          },
        })
      }
      if (updates.length > 0) r.editor.updateShapes(updates)
    }

    function onPointerUp(e: PointerEvent) {
      if (!_resizeState) return
      e.stopImmediatePropagation()
      _resizeState = null
      suppressBoundsUpdate.current = false
      // Update bounds to reflect new positions
      setBounds(getFleetBounds(editor))
    }

    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('pointermove', onPointerMove, { capture: true })
    window.addEventListener('pointerup', onPointerUp, { capture: true })

    return () => {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointermove', onPointerMove, { capture: true })
      window.removeEventListener('pointerup', onPointerUp, { capture: true })
      _resizeState = null
      suppressBoundsUpdate.current = false
    }
  }, [layoutMode, editor])

  if (!layoutMode || !bounds) return null

  const camera = editor.getCamera()
  const screenX = (bounds.x + camera.x) * camera.z
  const screenY = (bounds.y + camera.y) * camera.z
  const screenW = bounds.w * camera.z
  const screenH = bounds.h * camera.z

  return (
    <div
      ref={overlayRef}
      className="hud-layout-overlay"
      style={{
        position: 'absolute',
        left: screenX,
        top: screenY,
        width: screenW,
        height: screenH,
        pointerEvents: 'none',
        zIndex: 500,
      }}
    >
      {/* Container border — plain tldraw-style selection box */}
      <div style={{
        position: 'absolute', inset: 0,
        border: '1.5px solid rgba(59, 130, 246, 0.5)',
        borderRadius: 4,
        pointerEvents: 'none',
      }} />

      {HANDLES.map((handle) => {
        const style: React.CSSProperties = {
          position: 'absolute',
          width: HANDLE_SIZE, height: HANDLE_SIZE,
          background: 'rgba(59, 130, 246, 0.8)',
          border: '1px solid white',
          borderRadius: 2,
          pointerEvents: 'auto',
          cursor: handle === 'right' ? 'ew-resize'
            : handle === 'bottom' ? 'ns-resize'
            : handle.includes('left') && handle.includes('top') ? 'nwse-resize'
            : handle.includes('right') && handle.includes('top') ? 'nesw-resize'
            : handle.includes('left') && handle.includes('bottom') ? 'nesw-resize'
            : 'nwse-resize',
        }

        if (handle.includes('left')) style.left = -HANDLE_SIZE / 2
        if (handle.includes('right') && !handle.includes('left')) style.right = -HANDLE_SIZE / 2
        if (handle === 'right') { style.right = -HANDLE_SIZE / 2; style.top = '50%'; style.transform = 'translateY(-50%)' }
        if (handle.includes('top')) style.top = -HANDLE_SIZE / 2
        if (handle.includes('bottom') && !handle.includes('top')) style.bottom = -HANDLE_SIZE / 2
        if (handle === 'bottom') { style.bottom = -HANDLE_SIZE / 2; style.left = '50%'; style.transform = 'translateX(-50%)' }

        return <div key={handle} data-handle={handle} style={style} />
      })}
    </div>
  )
}
