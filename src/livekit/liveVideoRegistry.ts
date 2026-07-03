export interface LiveVideoTile {
  key: string
  identity: string
  name?: string
  trackSid?: string
  local?: boolean
  stream: MediaStream
}

const tiles = new Map<string, LiveVideoTile>()
const listeners = new Set<() => void>()
let snapshot: LiveVideoTile[] = []

function emit() {
  snapshot = [...tiles.values()]
  for (const listener of listeners) listener()
}

export function setLiveVideoTile(tile: LiveVideoTile) {
  tiles.set(tile.key, tile)
  emit()
}

export function removeLiveVideoTile(key: string) {
  tiles.delete(key)
  emit()
}

export function getLiveVideoTiles() {
  return snapshot
}

export function subscribeLiveVideoTiles(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
