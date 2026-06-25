/**
 * Camera link preference for dual-device workflows.
 * When linked, camera movements broadcast to and follow other viewers.
 * Stored per-browser in localStorage. Default: off.
 */

function isAutomatedBrowser() {
  return navigator.webdriver || new URL(window.location.href).searchParams.get('pw') === '1'
}

function readUrlOverride(): boolean | null {
  const value = new URL(window.location.href).searchParams.get('cameraLink')
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return null
}

function readCameraLinkedPreference() {
  try {
    return localStorage.getItem('tlda-camera-linked') === 'true'
  } catch {
    return false
  }
}

function writeCameraLinkedPreference(value: boolean) {
  try {
    localStorage.setItem('tlda-camera-linked', String(value))
    return true
  } catch {
    return false
  }
}

const automatedBrowser = isAutomatedBrowser()
const urlOverride = readUrlOverride()
if (automatedBrowser && urlOverride !== true) writeCameraLinkedPreference(false)

let linked = urlOverride ?? (!automatedBrowser && readCameraLinkedPreference())
const listeners = new Set<() => void>()

export function getCameraLinked(): boolean { return linked }

export function setCameraLinked(v: boolean) {
  if (v === linked) return
  linked = v
  writeCameraLinkedPreference(v)
  listeners.forEach(fn => fn())
}

export function toggleCameraLinked() { setCameraLinked(!linked) }

export function subscribeCameraLinked(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
