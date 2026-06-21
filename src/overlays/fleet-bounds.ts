export type PageBounds = { x: number; y: number; w: number; h: number }
export type FleetBoundsResult = {
  bounds: PageBounds | null
  shapeCount: number
  shapeLabels: string[]
  noBounds: string[]
}

export type FleetBoundsShape = {
  id: unknown
  type: string
}

export type StoreShapeChanges = {
  added?: Record<string, unknown>
  removed?: Record<string, unknown>
  updated?: Record<string, unknown>
}

type BoundsTrackerOptions<S extends FleetBoundsShape> = {
  isFleetShape: (shape: S) => boolean
  getShapePageBounds: (id: S['id']) => PageBounds | null | undefined
  pad?: number
}

const DEFAULT_PAD = 20
const EMPTY_RESULT: FleetBoundsResult = {
  bounds: null,
  shapeCount: 0,
  shapeLabels: [],
  noBounds: [],
}

function isShape<S extends FleetBoundsShape>(record: unknown): record is S {
  return !!record && typeof record === 'object' && (record as { typeName?: unknown }).typeName === 'shape'
}

function updatedPair<S extends FleetBoundsShape>(record: unknown): [S, S] | null {
  if (!Array.isArray(record) || record.length !== 2) return null
  const [from, to] = record
  if (!isShape<S>(from) || !isShape<S>(to)) return null
  return [from, to]
}

export function computeFleetBoundsFromShapes<S extends FleetBoundsShape>(
  shapes: Iterable<S>,
  getShapePageBounds: (id: S['id']) => PageBounds | null | undefined,
  pad = DEFAULT_PAD,
): FleetBoundsResult {
  let shapeCount = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const shapeLabels: string[] = []
  const noBounds: string[] = []

  for (const shape of shapes) {
    shapeCount += 1
    shapeLabels.push(`${shape.type}:${String(shape.id)}`)
    const bounds = getShapePageBounds(shape.id)
    if (!bounds) {
      noBounds.push(`${shape.type}:${String(shape.id)}`)
      continue
    }
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.w)
    maxY = Math.max(maxY, bounds.y + bounds.h)
  }

  if (shapeCount === 0 || !isFinite(minX)) {
    return { bounds: null, shapeCount, shapeLabels, noBounds }
  }

  return {
    bounds: {
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + pad * 2,
      h: maxY - minY + pad * 2,
    },
    shapeCount,
    shapeLabels,
    noBounds,
  }
}

export function createFleetBoundsTracker<S extends FleetBoundsShape>({
  isFleetShape,
  getShapePageBounds,
  pad = DEFAULT_PAD,
}: BoundsTrackerOptions<S>) {
  const fleetShapes = new Map<unknown, S>()
  let result = EMPTY_RESULT

  const recompute = () => {
    result = computeFleetBoundsFromShapes(fleetShapes.values(), getShapePageBounds, pad)
    return result
  }

  return {
    reset(shapes: Iterable<S>): FleetBoundsResult {
      fleetShapes.clear()
      for (const shape of shapes) {
        if (isFleetShape(shape)) fleetShapes.set(shape.id, shape)
      }
      return recompute()
    },

    applyChanges(changes: StoreShapeChanges): FleetBoundsResult | null {
      let changed = false

      for (const record of Object.values(changes.added ?? {})) {
        if (!isShape<S>(record)) continue
        if (!isFleetShape(record)) continue
        fleetShapes.set(record.id, record)
        changed = true
      }

      for (const record of Object.values(changes.removed ?? {})) {
        if (!isShape<S>(record)) continue
        if (fleetShapes.delete(record.id)) changed = true
      }

      for (const record of Object.values(changes.updated ?? {})) {
        const pair = updatedPair<S>(record)
        if (!pair) continue
        const [from, to] = pair
        const wasFleet = fleetShapes.has(from.id) || isFleetShape(from)
        const isFleet = isFleetShape(to)
        if (!wasFleet && !isFleet) continue
        if (isFleet) fleetShapes.set(to.id, to)
        else fleetShapes.delete(from.id)
        changed = true
      }

      return changed ? recompute() : null
    },

    getResult(): FleetBoundsResult {
      return result
    },

    get shapes(): readonly S[] {
      return [...fleetShapes.values()]
    },
  }
}
