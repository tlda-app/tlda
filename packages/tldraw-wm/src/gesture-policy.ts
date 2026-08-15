// Match TLDraw's touch pinch classifier where possible:
//   not-sure -> resize/zoom after 24px finger-distance change
//   not-sure -> move/pan after 16px center movement
//   move/pan -> resize/zoom only after 64px finger-distance change
// See @tldraw/editor/src/lib/hooks/useGestureEvents.ts. Axis resistance is
// independent, but neither axis damps or gates the other after release.
export const MOVE_LOCK_ON = 16
export const RESIZE_LOCK_ON = 24
export const RESIZE_LOCK_AFTER_MOVE = 64
export const RESIZE_SNAP_RESISTANCE = 8

export const PAN_LOCK_INITIAL = 8    // px of (decayed) travel before the lock engages
export const PAN_BREAK_RATIO = 1.6   // off-axis must out-travel the locked axis by this to flip it
export const PAN_OFFAXIS_DAMP = 0.45 // residual off-axis fraction while locked (0 would be a hard lock)
export const PAN_AXIS_DECAY = 0.8    // per-move decay of the axis accumulators (recent-motion weighting)
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

/** A continuous sticky point: motion inside the resistance stays at the snap;
 * after it breaks, every further pixel produces one pixel of output. */
export function applyAxisResistance(delta: number, resistance: number): { delta: number; stuck: boolean } {
	const distance = Math.abs(delta)
	if (distance <= resistance) return { delta: 0, stuck: true }
	return { delta: Math.sign(delta) * (distance - resistance), stuck: false }
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
