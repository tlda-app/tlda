/**
 * Camera link preference for dual-device workflows.
 * When linked, camera movements broadcast to and follow other viewers.
 * Stored per-browser in localStorage. Default: on.
 */

let linked = localStorage.getItem('tlda-camera-linked') !== 'false'
const listeners = new Set<() => void>()

export function getCameraLinked(): boolean { return linked }

export function setCameraLinked(v: boolean) {
  if (v === linked) return
  linked = v
  localStorage.setItem('tlda-camera-linked', String(v))
  listeners.forEach(fn => fn())
}

export function toggleCameraLinked() { setCameraLinked(!linked) }

export function subscribeCameraLinked(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
