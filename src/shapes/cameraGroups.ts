/**
 * Shared camera state for grouped ZoomableImageShapes.
 * Images with the same cameraGroup share zoom/pan state.
 */

export interface CameraState {
  zoom: number
  x: number
  y: number
}

type Listener = (state: CameraState) => void

const groups = new Map<string, CameraState>()
const listeners = new Map<string, Set<Listener>>()

export function getCameraGroup(group: string): CameraState {
  let state = groups.get(group)
  if (!state) {
    state = { zoom: 1, x: 0, y: 0 }
    groups.set(group, state)
  }
  return state
}

export function setCameraGroup(group: string, state: CameraState) {
  groups.set(group, state)
  const subs = listeners.get(group)
  if (subs) {
    for (const cb of subs) cb(state)
  }
}

export function subscribeCameraGroup(group: string, cb: Listener): () => void {
  let subs = listeners.get(group)
  if (!subs) {
    subs = new Set()
    listeners.set(group, subs)
  }
  subs.add(cb)
  return () => {
    subs!.delete(cb)
    if (subs!.size === 0) listeners.delete(group)
  }
}
