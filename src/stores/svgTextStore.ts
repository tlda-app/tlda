/**
 * Reactive SVG text store.
 * Keyed by shape ID, not synced through Yjs.
 * Components subscribe via useSyncExternalStore; writes go through setSvgText.
 */

const svgTextMap = new Map<string, string>()
const svgTextListeners = new Map<string, Set<() => void>>()

function notifySvgTextListeners(shapeId: string) {
  const listeners = svgTextListeners.get(shapeId)
  if (listeners) for (const fn of listeners) fn()
}

export function subscribeSvgText(shapeId: string, cb: () => void): () => void {
  if (!svgTextListeners.has(shapeId)) svgTextListeners.set(shapeId, new Set())
  svgTextListeners.get(shapeId)!.add(cb)
  return () => svgTextListeners.get(shapeId)?.delete(cb)
}

export function getSvgText(shapeId: string): string | undefined {
  return svgTextMap.get(shapeId)
}

export function hasSvgText(shapeId: string): boolean {
  return svgTextMap.has(shapeId)
}

export function setSvgText(shapeId: string, text: string) {
  if (svgTextMap.get(shapeId) === text) return  // dedup: no-op if identical
  svgTextMap.set(shapeId, text)
  notifySvgTextListeners(shapeId)
}

export function deleteSvgText(shapeId: string) {
  if (!svgTextMap.has(shapeId)) return
  svgTextMap.delete(shapeId)
  notifySvgTextListeners(shapeId)
}

export function clearSvgTextStore() {
  const ids = [...svgTextMap.keys()]
  svgTextMap.clear()
  for (const id of ids) notifySvgTextListeners(id)
}
