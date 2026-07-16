export type FleetFilterDropRole = 'to' | 'from' | 'replace'
export type FleetFilterPreview = [string, string][][]

export type FleetFilterDropPreviewState = {
  toPreview: FleetFilterPreview | null
  fromPreview: FleetFilterPreview | null
  replacePreview: FleetFilterPreview | null
  activePaneRole: FleetFilterDropRole | null
}

export type FleetFilterDropBounds = {
  x: number
  y: number
  w: number
  h: number
}

export function inferFleetFilterDropRole(
  bounds: FleetFilterDropBounds | null | undefined,
  pagePoint: { x: number; y: number } | null | undefined,
): FleetFilterDropRole | null {
  if (!bounds || !pagePoint) return null
  if (
    pagePoint.x < bounds.x ||
    pagePoint.x > bounds.x + bounds.w ||
    pagePoint.y < bounds.y ||
    pagePoint.y > bounds.y + bounds.h
  ) return null
  if (pagePoint.x <= bounds.x + bounds.w / 3) return 'replace'
  return pagePoint.y <= bounds.y + bounds.h / 2 ? 'to' : 'from'
}

export function filterPreviewForDropRole(
  state: FleetFilterDropPreviewState,
  role: FleetFilterDropRole | null,
): FleetFilterPreview | null {
  if (role === 'replace') return state.replacePreview
  if (role === 'to') return state.toPreview
  if (role === 'from') return state.fromPreview
  return null
}
