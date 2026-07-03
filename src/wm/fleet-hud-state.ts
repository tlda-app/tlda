export const FLEET_HUD_EXPANDED_STORAGE_KEY = 'fleet-hud-expanded'

function hasLocalStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

export function readFleetHudExpanded(): boolean {
  if (!hasLocalStorage()) return false
  return localStorage.getItem(FLEET_HUD_EXPANDED_STORAGE_KEY) === '1'
}

export function writeFleetHudExpanded(expanded: boolean): void {
  if (!hasLocalStorage()) return
  localStorage.setItem(FLEET_HUD_EXPANDED_STORAGE_KEY, expanded ? '1' : '0')
}

export function isFleetHudHidden(): boolean {
  return !readFleetHudExpanded()
}

export function resolveFleetHudToggle(previous: boolean, requested: unknown): boolean {
  return typeof requested === 'boolean' ? requested : !previous
}
