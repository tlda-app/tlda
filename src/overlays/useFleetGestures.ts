/**
 * useFleetGestures — touch gesture vocabulary for the fleet HUD.
 *
 * Special-case touch ONLY when the fingers are over a fleet shape; otherwise the
 * canvas behaves like standard TLDraw. The vocabulary (Skip's locked design):
 *
 *   1 finger / stylus   → scroll the content under it (not intercepted here —
 *                         the shape's own scroll handling runs)
 *   2 fingers on a shape → move it (translate with the fingers' center) and
 *                         resize it (scale with the fingers' spread) at once
 *   2 fingers spanning shapes → move that cluster (the margin-group), so the
 *                         other margin's cluster stays put
 *   3 fingers           → "pass-through": behave as a standard canvas 2-finger
 *                         gesture — drag = pan, pinch = zoom — wherever you are
 *
 * Why a capture-phase listener on the HUD wrap: every fleet shape root calls
 * stopEventPropagation on pointerdown, so TLDraw (and bubble-phase handlers)
 * never see the press. We intercept above that, identify the shape under the
 * touch centroid via the overlay (copy) editor, and apply the change to the
 * MAIN editor (window.__tldraw_editor__) — fleet shapes carry real x/y/w/h in
 * Yjs, so a main-editor updateShape persists and the HUD copy re-mirrors it.
 * Writing to the copy editor would be clobbered by the main→copy mirror (that's
 * the "snap-back" the old two-finger move exhibited).
 */
import { useEffect } from 'react'
import type { Editor, TLShape } from 'tldraw'
import { FLEET_SHAPE_TYPES } from '../shapes/fleet-utils'

function getMainEditor(fallback: Editor): Editor {
  if (typeof window !== 'undefined') {
    const w = (window as any).__tldraw_editor__ as Editor | undefined
    if (w) return w
  }
  return fallback
}

const touchDist = (a: Touch, b: Touch) => Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
function touchCenter(ts: Touch[]) {
  let x = 0, y = 0
  for (const t of ts) { x += t.clientX; y += t.clientY }
  return { x: x / ts.length, y: y / ts.length }
}

// The fleet shape (if any) under a screen point, using the overlay editor's
// camera to map screen → page. Returns the shape on the overlay (copy) store;
// its id matches the main-store shape.
function fleetShapeAtScreen(overlay: Editor, clientX: number, clientY: number): TLShape | null {
  const rect = overlay.getContainer().getBoundingClientRect()
  const page = overlay.screenToPage({ x: clientX - rect.left, y: clientY - rect.top })
  const shape = overlay.getShapeAtPoint(page, { hitInside: true, margin: 0 })
  if (shape && FLEET_SHAPE_TYPES.has(shape.type as string)) return shape
  // Walk up to a fleet ancestor (e.g. a nested child like a chat inside a container)
  let cur = shape
  while (cur) {
    const parent = overlay.getShape(cur.parentId as any)
    if (!parent) break
    if (FLEET_SHAPE_TYPES.has(parent.type as string)) return parent
    cur = parent
  }
  return null
}

// All my fleet shapes that share a cluster with `seed` — same horizontal
// margin. We split by whether the shape's center-x is left or right of the
// owned-shapes' overall center, so the two margins move independently.
function clusterOf(main: Editor, seedIds: Set<string>): TLShape[] {
  const fleet = main.getCurrentPageShapes().filter(s => FLEET_SHAPE_TYPES.has(s.type as string))
  const bounds = fleet.map(s => ({ s, b: main.getShapePageBounds(s.id) })).filter(x => x.b)
  if (bounds.length === 0) return []
  const minX = Math.min(...bounds.map(x => x.b!.minX))
  const maxX = Math.max(...bounds.map(x => x.b!.maxX))
  const mid = (minX + maxX) / 2
  const sideOf = (b: any) => (b.minX + b.maxX) / 2 < mid ? 'L' : 'R'
  // Which side(s) the seed shapes are on
  const seedSides = new Set(bounds.filter(x => seedIds.has(x.s.id)).map(x => sideOf(x.b)))
  return bounds.filter(x => seedSides.has(sideOf(x.b))).map(x => x.s)
}

// A 2-finger gesture on one shape commits to EITHER move or resize — never both
// at once — so sliding to reposition doesn't also zoom the shape. Mode locks the
// first time the fingers move past a small threshold, by whichever dominates:
// sliding-together → move, spreading/pinching → resize.
const LOCK_THRESHOLD = 12 // screen px of travel before we commit to a mode

type GestureState =
  | { kind: 'none' }
  | { kind: 'shape'; mode: 'pending' | 'move' | 'resize'; id: string; type: string; x0: number; y0: number; w0: number; h0: number; d0: number; c0: { x: number; y: number } }
  | { kind: 'cluster'; shapes: { id: string; type: string; x0: number; y0: number }[]; c0: { x: number; y: number } }
  // 3-finger is parked for now: we intercept it (so the shapes don't grab it) but
  // do nothing, until the pass-through-to-canvas can be done without side effects.
  | { kind: 'inert' }

export function useFleetGestures(opts: {
  hudRef: React.RefObject<HTMLDivElement | null>
  overlayEditorRef: React.MutableRefObject<Editor | null>
  mainEditor: Editor
  expanded: boolean
}) {
  const { hudRef, overlayEditorRef, mainEditor, expanded } = opts

  useEffect(() => {
    if (!expanded) return
    const el = hudRef.current
    if (!el) return

    let state: GestureState = { kind: 'none' }

    const onTouchStart = (e: TouchEvent) => {
      const overlay = overlayEditorRef.current
      if (!overlay) return
      const main = getMainEditor(mainEditor)
      const ts = Array.from(e.touches)

      if (ts.length === 3) {
        // Parked: swallow it so it doesn't reach the shapes, but do nothing else.
        e.preventDefault(); e.stopPropagation()
        state = { kind: 'inert' }
        return
      }

      if (ts.length === 2) {
        const s0 = fleetShapeAtScreen(overlay, ts[0].clientX, ts[0].clientY)
        const s1 = fleetShapeAtScreen(overlay, ts[1].clientX, ts[1].clientY)
        if (!s0 && !s1) return // not on a fleet shape → let TLDraw pan/zoom
        const ids = new Set([s0?.id, s1?.id].filter(Boolean) as string[])

        if (ids.size === 1 && s0 && s1) {
          // Both fingers on one shape → move + pinch-resize that shape
          const shape = s0
          const b = main.getShapePageBounds(shape.id)
          if (!b) return
          e.preventDefault(); e.stopPropagation()
          main.markHistoryStoppingPoint() // whole gesture = one undo step
          state = {
            kind: 'shape', mode: 'pending', id: shape.id, type: shape.type as string,
            x0: (main.getShape(shape.id as any) as any).x, y0: (main.getShape(shape.id as any) as any).y,
            w0: b.width, h0: b.height, d0: touchDist(ts[0], ts[1]), c0: touchCenter(ts),
          }
        } else {
          // Fingers span >1 shape → move that cluster
          e.preventDefault(); e.stopPropagation()
          main.markHistoryStoppingPoint()
          const shapes = clusterOf(main, ids).map(s => {
            const m = main.getShape(s.id as any) as any
            return { id: s.id, type: s.type as string, x0: m.x, y0: m.y }
          })
          state = { kind: 'cluster', shapes, c0: touchCenter(ts) }
        }
      }
      // 1 finger: not intercepted — the shape's own scroll handling runs.
    }

    const onTouchMove = (e: TouchEvent) => {
      if (state.kind === 'none') return
      const overlay = overlayEditorRef.current
      if (!overlay) return
      const main = getMainEditor(mainEditor)
      const ts = Array.from(e.touches)
      const zoom = overlay.getCamera().z || 1

      if (state.kind === 'inert') {
        e.preventDefault(); e.stopPropagation()
        return
      }

      if (state.kind === 'shape' && ts.length >= 2) {
        e.preventDefault(); e.stopPropagation()
        const c = touchCenter(ts)
        const d = touchDist(ts[0], ts[1])
        const travel = Math.hypot(c.x - state.c0.x, c.y - state.c0.y) // center slide
        const spread = Math.abs(d - state.d0)                          // pinch amount
        // Commit to a mode once either motion is deliberate enough.
        if (state.mode === 'pending' && Math.max(travel, spread) >= LOCK_THRESHOLD) {
          state.mode = spread > travel ? 'resize' : 'move'
        }
        if (state.mode === 'move') {
          const dx = (c.x - state.c0.x) / zoom
          const dy = (c.y - state.c0.y) / zoom
          main.updateShape({ id: state.id as any, type: state.type as any, x: state.x0 + dx, y: state.y0 + dy })
        } else if (state.mode === 'resize') {
          const scale = state.d0 > 0 ? d / state.d0 : 1
          const newW = Math.max(80, state.w0 * scale)
          const newH = Math.max(60, state.h0 * scale)
          main.updateShape({ id: state.id as any, type: state.type as any, props: { w: newW, h: newH } as any })
        }
        return
      }

      if (state.kind === 'cluster' && ts.length >= 2) {
        e.preventDefault(); e.stopPropagation()
        const c = touchCenter(ts)
        const dx = (c.x - state.c0.x) / zoom
        const dy = (c.y - state.c0.y) / zoom
        for (const s of state.shapes) {
          main.updateShape({ id: s.id as any, type: s.type as any, x: s.x0 + dx, y: s.y0 + dy })
        }
        return
      }
    }

    const reset = (e: TouchEvent) => {
      if (e.touches.length < 2) state = { kind: 'none' }
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false, capture: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    el.addEventListener('touchend', reset, { capture: true })
    el.addEventListener('touchcancel', reset, { capture: true })
    return () => {
      el.removeEventListener('touchstart', onTouchStart, { capture: true } as any)
      el.removeEventListener('touchmove', onTouchMove, { capture: true } as any)
      el.removeEventListener('touchend', reset, { capture: true } as any)
      el.removeEventListener('touchcancel', reset, { capture: true } as any)
    }
  }, [expanded, hudRef, overlayEditorRef, mainEditor])
}
