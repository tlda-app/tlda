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

/** Tell the HUD that the camera move about to happen is navigation, not a pan.
 *  Without this the HUD records the move as a deliberate pan: it persists the
 *  displaced anchor to Yjs and latches off its own self-heal. */
export function suppressFleetHudCameraTracking(durationMs = 700): void {
  const win = window as Window & { __tldaFleetHudSuppressCameraTrackingUntil?: number }
  win.__tldaFleetHudSuppressCameraTrackingUntil = Math.max(
    Number(win.__tldaFleetHudSuppressCameraTrackingUntil || 0),
    Date.now() + durationMs,
  )
}
