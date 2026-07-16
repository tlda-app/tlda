// Match TLDraw's touch pinch classifier where possible:
//   not-sure -> resize/zoom after 24px finger-distance change
//   not-sure -> move/pan after 16px center movement
//   move/pan -> resize/zoom only after 64px finger-distance change
// See @tldraw/editor/src/lib/hooks/useGestureEvents.ts. We keep anisotropic
// resizing as our HUD-specific extension, but use the same commitment ordering.
export const MOVE_LOCK_ON = 16
export const RESIZE_LOCK_ON = 24
export const RESIZE_LOCK_AFTER_MOVE = 64

export const PAN_LOCK_INITIAL = 8    // px of (decayed) travel before the lock engages
export const PAN_BREAK_RATIO = 1.6   // off-axis must out-travel the locked axis by this to flip it
export const PAN_OFFAXIS_DAMP = 0.12 // residual off-axis fraction while locked (0 would be a hard lock)
export const PAN_AXIS_DECAY = 0.8    // per-move decay of the axis accumulators (recent-motion weighting)
export const RESIZE_AXIS_LOCK_INITIAL = 12
export const RESIZE_AXIS_BREAK_RATIO = 1.6
export const RESIZE_AXIS_OFFAXIS_DAMP = 0.12
export const RESIZE_AXIS_DECAY = 0.8

export type SoftAxis = 'x' | 'y' | null

export interface WmLaneStop<TLane extends string = string> {
	lane: TLane
	docLeftScreen: number
}

export function classifySoftGesture(input: {
  moveActive: boolean
  resizeActive: boolean
  travel: number
  spread: number
}) {
  let moveActive = input.moveActive
  let resizeActive = input.resizeActive

  if (!resizeActive) {
    if (!moveActive && input.spread > RESIZE_LOCK_ON) {
      resizeActive = true
    } else {
      if (input.travel > MOVE_LOCK_ON) moveActive = true
      if (moveActive && input.spread > RESIZE_LOCK_AFTER_MOVE) resizeActive = true
    }
  }

  // TLDraw's zooming pinch still dispatches center deltas. Once a HUD pinch has
  // committed to resize, translate by the finger center too so the pinch center
  // remains the user's fingers rather than the original shape point.
  if (resizeActive) moveActive = true

  return { moveActive, resizeActive }
}

export function applyShapeResizeAxisLock(input: {
  enabled: boolean
  axis: SoftAxis
  accX: number
  accY: number
  spanDx: number
  spanDy: number
  scaleX: number
  scaleY: number
}) {
  let { axis, accX, accY, scaleX, scaleY } = input
  if (!input.enabled) return { axis, accX, accY, scaleX, scaleY }

  accX = accX * RESIZE_AXIS_DECAY + Math.abs(input.spanDx)
  accY = accY * RESIZE_AXIS_DECAY + Math.abs(input.spanDy)
  if (accX + accY >= RESIZE_AXIS_LOCK_INITIAL) {
    if (axis === null) axis = accY >= accX ? 'y' : 'x'
    else if (axis === 'y' && accX > accY * RESIZE_AXIS_BREAK_RATIO) axis = 'x'
    else if (axis === 'x' && accY > accX * RESIZE_AXIS_BREAK_RATIO) axis = 'y'
  }

  if (axis === 'x') scaleY = 1 + (scaleY - 1) * RESIZE_AXIS_OFFAXIS_DAMP
  else if (axis === 'y') scaleX = 1 + (scaleX - 1) * RESIZE_AXIS_OFFAXIS_DAMP
  return { axis, accX, accY, scaleX, scaleY }
}

export function nearestLaneDocLeftScreen<TLane extends string>(
	docLeftScreen: number,
	stops: readonly WmLaneStop<TLane>[],
): WmLaneStop<TLane> {
	if (stops.length === 0) throw new Error('nearestLaneDocLeftScreen requires at least one lane stop')
	return stops.reduce((best, stop) =>
    Math.abs(stop.docLeftScreen - docLeftScreen) < Math.abs(best.docLeftScreen - docLeftScreen) ? stop : best,
  )
}
