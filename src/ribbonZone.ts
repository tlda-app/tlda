export type RibbonZoneBounds = {
  minX: number
  maxX: number
}

export function overlapsRibbonX(bounds: RibbonZoneBounds, ribbonBounds: RibbonZoneBounds): boolean {
  return bounds.minX < ribbonBounds.maxX && bounds.maxX > ribbonBounds.minX
}
