import type { ClipBounds } from '../CanvasClipPanel'

export type FleetHudDefaultAnchor = {
  panOffset: number
  cameraY: number
}

export function computeFleetHudDefaultAnchor({
  bounds,
  docPageLeft,
  docLeftScreen,
  layoutDx,
  topPad,
}: {
  bounds: ClipBounds
  docPageLeft: number
  docLeftScreen: number
  layoutDx: number
  topPad: number
}): FleetHudDefaultAnchor {
  return {
    panOffset: docLeftScreen - docPageLeft - layoutDx,
    cameraY: topPad - bounds.y,
  }
}
