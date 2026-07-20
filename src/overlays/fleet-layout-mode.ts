export const fleetLayoutActiveRef = { current: false }

let fleetLayoutSelectionIntentId: string | null = null

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
