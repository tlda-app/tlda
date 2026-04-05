/**
 * Module-level store for timeline overlay data.
 *
 * TLDraw's shape meta validator rejects nested objects (arrays of objects),
 * so we store timeline data outside the shape and let the component read it
 * via useSyncExternalStore.
 */

import type { TimelineData } from './shapes/TimelineOverlayShape'

let currentData: TimelineData | null = null
const listeners = new Set<() => void>()

export function setTimelineData(data: TimelineData | null) {
  currentData = data
  for (const cb of listeners) cb()
}

export function getTimelineData(): TimelineData | null {
  return currentData
}

export function subscribeTimelineData(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
