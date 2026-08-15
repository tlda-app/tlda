export const RIBBON_LANE_X = -6
export const RIBBON_LANE_WIDTH = 6
export const RIBBON_HIT_WIDTH_PX = 14

export function ribbonHitWidthScreen(renderedLaneWidth: number): number {
  return Math.max(renderedLaneWidth, RIBBON_HIT_WIDTH_PX)
}

export function ribbonPageHitStrip(zoom: number): { minX: number; maxX: number } {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1
  const maxX = RIBBON_LANE_X + RIBBON_LANE_WIDTH
  return {
    minX: maxX - Math.max(RIBBON_LANE_WIDTH, RIBBON_HIT_WIDTH_PX / safeZoom),
    maxX,
  }
}
