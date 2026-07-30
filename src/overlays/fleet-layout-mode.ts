import type { Editor } from 'tldraw'

export const fleetLayoutActiveRef = { current: false }

let fleetLayoutSelectionIntentId: string | null = null
const fleetLayoutViewportSync = new WeakMap<Editor, () => void>()

export function registerFleetLayoutViewportSync(editor: Editor, sync: () => void) {
  fleetLayoutViewportSync.set(editor, sync)
  return () => {
    if (fleetLayoutViewportSync.get(editor) === sync) fleetLayoutViewportSync.delete(editor)
  }
}

export function syncFleetLayoutSelectionViewport(editor: Editor) {
  fleetLayoutViewportSync.get(editor)?.()
}

export function withFleetLayoutSelectionIntent<T>(shapeId: string, fn: () => T): T {
  fleetLayoutSelectionIntentId = shapeId
  try {
    return fn()
  } finally {
    fleetLayoutSelectionIntentId = null
  }
}

export function consumeFleetLayoutSelectionIntent(shapeIds: readonly string[]): boolean {
  for (const id of shapeIds) {
    if (id !== fleetLayoutSelectionIntentId) continue
    fleetLayoutSelectionIntentId = null
    return true
  }
  return false
}

export function enterFleetLayoutMode() {
  fleetLayoutActiveRef.current = true
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('.fleet-hud-wrap')
    .forEach(el => el.classList.add('hud-layout-active'))
  document.body.classList.add('fleet-hud-fleet-selected')
}

export function exitFleetLayoutMode() {
  fleetLayoutActiveRef.current = false
  if (typeof document === 'undefined') return
  document.querySelectorAll<HTMLElement>('.fleet-hud-wrap')
    .forEach(el => el.classList.remove('hud-layout-active'))
  document.body.classList.remove('fleet-hud-fleet-selected')
}
