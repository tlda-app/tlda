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

// My fleet shapes that share a margin with the seed shapes. Source the set from
// the OVERLAY editor, not the main store: the overlay holds only my current
// (identity, device) shapes, so other devices' sets and junk-identity orphans —
// which live in the shared room but are NOT in the HUD — can't pollute the
// cluster (the bug where foreign shapes with no HUD element defaulted to "left").
// The split itself is on what the user sees: each panel's on-SCREEN center-x vs
// the document's on-SCREEN center-x (page coords don't line up — the doc is in
// the main-camera frame, the panels in the overlay's override-camera frame).
function clusterOf(overlay: Editor, seedIds: Set<string>): TLShape[] {
  const fleet = overlay.getCurrentPageShapes().filter(s => FLEET_SHAPE_TYPES.has(s.type as string))
  if (fleet.length === 0) return []
  // Document's screen center-x, read from the doc page's actual rendered DOM rect
  // on the main canvas — the SAME getBoundingClientRect frame as the panels below
  // (pageToScreen doesn't line up with where the doc actually paints under the HUD).
  const docEls = Array.from(document.querySelectorAll('[data-shape-type="svg-page"], [data-shape-type="html-page"]'))
    .filter(el => !el.closest('.fleet-hud-wrap'))
  let docScreenMidX = window.innerWidth / 2
  if (docEls.length) {
    const rs = docEls.map(el => el.getBoundingClientRect())
    docScreenMidX = (Math.min(...rs.map(r => r.left)) + Math.max(...rs.map(r => r.right))) / 2
  }
  // Each panel's screen center-x, read from its rendered DOM element (which the
  // override camera has already positioned), so both sides are in screen space.
  const sideOf = (id: string): 'L' | 'R' => {
    const el = document.querySelector(`.fleet-hud-wrap [data-shape-id="${id}"]`)
    if (!el) return 'L'
    const r = el.getBoundingClientRect()
    return (r.left + r.right) / 2 < docScreenMidX ? 'L' : 'R'
  }
  const seedSides = new Set([...seedIds].map(id => sideOf(id)))
  return fleet.filter(s => seedSides.has(sideOf(s.id)))
}

// A 2-finger gesture on one shape commits to EITHER move or resize — never both
// at once — so sliding to reposition doesn't also zoom the shape. Mode locks the
// first time the fingers move past a small threshold, by whichever dominates:
// sliding-together → move, spreading/pinching → resize.
const LOCK_THRESHOLD = 12 // screen px of travel before we commit to a mode

// 3-finger pan soft axis lock (Skip's "soft/breakable" choice — cf. the hard-snap
// variant in src/hooks/usePanMode.ts). Engage after a little travel, bias hard to
// the dominant axis but leave a sliver of off-axis motion (soft, not rigid), and
// let a decisive off-axis push re-pick the axis mid-drag (breakable — no pause
// needed). The accumulators decay each move so the axis tracks RECENT travel.
const PAN_LOCK_INITIAL = 8    // px of (decayed) travel before the lock engages
const PAN_BREAK_RATIO = 1.6   // off-axis must out-travel the locked axis by this to flip it
const PAN_OFFAXIS_DAMP = 0.12 // residual off-axis fraction while locked (0 would be a hard lock)
const PAN_AXIS_DECAY = 0.8    // per-move decay of the axis accumulators (recent-motion weighting)

type GestureState =
  | { kind: 'none' }
  | { kind: 'shape'; mode: 'pending' | 'move' | 'resize'; id: string; type: string; x0: number; y0: number; w0: number; h0: number; d0: number; c0: { x: number; y: number } }
  | { kind: 'cluster'; mode: 'pending' | 'move' | 'resize'; shapes: { id: string; type: string; x0: number; y0: number; w0: number; h0: number }[]; anchor: { x: number; y: number }; d0: number; c0: { x: number; y: number } }
  // 3-finger: pan the main canvas from anywhere (even over the panels). Drive the
  // main camera; the HUD's camera-poll mirrors a main-camera pan onto the HUD.
  // Keep z byte-identical — a z wobble makes the poll skip the HUD update.
  // Integrates incremental deltas (lastC) so a soft axis lock can damp the
  // off-axis without the camera jumping when the lock breaks mid-drag.
  | { kind: 'pan'; z0: number; lastC: { x: number; y: number }; axis: 'x' | 'y' | null; accX: number; accY: number }

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
        // Pan the doc from anywhere — even over the panels.
        e.preventDefault(); e.stopPropagation()
        const cam = main.getCamera()
        state = { kind: 'pan', z0: cam.z, lastC: touchCenter(ts), axis: null, accX: 0, accY: 0 }
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
          // Fingers span >1 shape → move OR pinch-resize that margin's cluster.
          e.preventDefault(); e.stopPropagation()
          main.markHistoryStoppingPoint()
          const shapes = clusterOf(overlay, ids).map(s => {
            const m = main.getShape(s.id as any) as any
            const b = main.getShapePageBounds(s.id)
            return { id: s.id, type: s.type as string, x0: m.x, y0: m.y, w0: b ? b.width : 0, h0: b ? b.height : 0 }
          })
          if (shapes.length === 0) return
          // Scale pivot = centroid of the panels' own positions+sizes. Computed
          // from the shapes (never a {0,0} fallback) — these page coords can be
          // huge, so a wrong pivot would fling them off into space.
          const cx = shapes.reduce((a, s) => a + s.x0 + s.w0 / 2, 0) / shapes.length
          const cy = shapes.reduce((a, s) => a + s.y0 + s.h0 / 2, 0) / shapes.length
          state = { kind: 'cluster', mode: 'pending', shapes, anchor: { x: cx, y: cy }, d0: touchDist(ts[0], ts[1]), c0: touchCenter(ts) }
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

      if (state.kind === 'pan') {
        e.preventDefault(); e.stopPropagation()
        const c = touchCenter(ts)
        const idx = c.x - state.lastC.x // incremental delta since last move
        const idy = c.y - state.lastC.y
        state.lastC = c
        // Soft, breakable axis lock. Decay the accumulators so the axis is chosen
        // from RECENT travel: once past the threshold, lock to the dominant axis;
        // a decisive off-axis push (the other axis out-travels the locked one by
        // PAN_BREAK_RATIO) flips the lock mid-drag, no pause needed.
        state.accX = state.accX * PAN_AXIS_DECAY + Math.abs(idx)
        state.accY = state.accY * PAN_AXIS_DECAY + Math.abs(idy)
        if (state.accX + state.accY >= PAN_LOCK_INITIAL) {
          if (state.axis === null) state.axis = state.accY >= state.accX ? 'y' : 'x'
          else if (state.axis === 'y' && state.accX > state.accY * PAN_BREAK_RATIO) state.axis = 'x'
          else if (state.axis === 'x' && state.accY > state.accX * PAN_BREAK_RATIO) state.axis = 'y'
        }
        // Damp (not zero) the off-axis component — soft, not rigid.
        let mx = idx, my = idy
        if (state.axis === 'y') mx *= PAN_OFFAXIS_DAMP
        else if (state.axis === 'x') my *= PAN_OFFAXIS_DAMP
        // Integrate into the live camera. z written byte-identical (z0) every
        // frame — a z wobble makes the HUD camera-poll skip the pan mirror.
        const cam = main.getCamera()
        main.setCamera(
          { x: cam.x + mx / state.z0, y: cam.y + my / state.z0, z: state.z0 },
          { animation: { duration: 0 } },
        )
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
        const d = touchDist(ts[0], ts[1])
        const travel = Math.hypot(c.x - state.c0.x, c.y - state.c0.y)
        const spread = Math.abs(d - state.d0)
        if (state.mode === 'pending' && Math.max(travel, spread) >= LOCK_THRESHOLD) {
          state.mode = spread > travel ? 'resize' : 'move'
        }
        if (state.mode === 'move') {
          const dx = (c.x - state.c0.x) / zoom
          const dy = (c.y - state.c0.y) / zoom
          for (const s of state.shapes) {
            main.updateShape({ id: s.id as any, type: s.type as any, x: s.x0 + dx, y: s.y0 + dy })
          }
        } else if (state.mode === 'resize') {
          // Scale the whole cluster about its pivot — clamp so a wild pinch can't
          // fling the panels (their page coords are large).
          const raw = state.d0 > 0 ? d / state.d0 : 1
          const scale = Math.max(0.3, Math.min(3, raw))
          for (const s of state.shapes) {
            main.updateShape({
              id: s.id as any, type: s.type as any,
              x: state.anchor.x + (s.x0 - state.anchor.x) * scale,
              y: state.anchor.y + (s.y0 - state.anchor.y) * scale,
              props: { w: Math.max(80, s.w0 * scale), h: Math.max(60, s.h0 * scale) } as any,
            })
          }
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
